import { test, expect, type Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent, readyCanvas } from './connection-helpers';
import type { DiagramSnapshot } from '../src/editor/controller';
import type { Arrowhead, Operation } from '../src/protocol';

test.setTimeout(90_000);
type Applied = DiagramSnapshot & { copies: { sourceId: string; id: string }[] };
async function read(client: Client) {
  const result = await client.callTool({ name: 'get_diagram', arguments: {} });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as DiagramSnapshot;
}
async function apply(client: Client, operations: Operation[]) {
  const state = await read(client);
  const result = await client.callTool({ name: 'apply_operations', arguments: {
    diagramId: state.diagramId, expectedRevision: state.revision, requestId: crypto.randomUUID(), operations,
  } });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as Applied;
}
const element = (state: DiagramSnapshot, id: string) => state.elements.find(e => e.id === id)!;
async function exported(client: Client, diagramId: string, format: 'excalidraw' | 'svg' = 'excalidraw') {
  const result = await client.callTool({ name: 'export_diagram', arguments: { diagramId, format } });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const first = result.structuredContent as { artifactId: string; data: string; nextOffset: number | null };
  let data = first.data, offset = first.nextOffset;
  while (offset !== null) {
    const chunk = await client.callTool({ name: 'read_export', arguments: { artifactId: first.artifactId, offset } });
    expect(chunk.isError).not.toBe(true);
    const next = chunk.structuredContent as { data: string; nextOffset: number | null };
    data += next.data; offset = next.nextOffset;
  }
  await client.callTool({ name: 'release_transfer', arguments: { transferId: first.artifactId } });
  return data;
}
async function undo(page: Page) {
  await page.locator('.excalidraw.excalidraw-container').focus();
  await page.keyboard.press('ControlOrMeta+z');
}
function orthogonal(points: number[][]) {
  points.slice(1).forEach((p, i) => expect(Math.min(Math.abs(p[0] - points[i][0]), Math.abs(p[1] - points[i][1]))).toBeLessThan(0.001));
}

test('native markers render on plain lines with solid, dashed and dotted strokes and clear independently', async ({ page }, info) => {
  const client = await connectAgent(page);
  const heads: Arrowhead[] = ['arrow', 'triangle', 'bar', 'dot', 'circle', 'circle_outline', 'triangle_outline',
    'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'];
  const created = await apply(client, heads.map((head, i) => ({
    op: 'create_line', id: head, kind: 'line', points: [[200, 100 + i * 48], [650, 100 + i * 48]],
    startArrowhead: head, endArrowhead: head, strokeStyle: (['solid', 'dashed', 'dotted'] as const)[i % 3], strokeWidth: 1 + i % 4,
  })));
  expect(created.elements).toHaveLength(heads.length); // No detached decoration primitives.
  for (const head of heads) expect(element(created, head)).toMatchObject({ type: 'arrow', startArrowhead: head, endArrowhead: head });
  const shapesPerLine = async () => page.evaluate(svg => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return [...doc.documentElement.children].filter(e => e.tagName === 'g' && e.getAttribute('stroke-linecap') === 'round').map(e => e.children.length);
  }, await exported(client, created.diagramId, 'svg'));
  const marked = await shapesPerLine();
  expect(marked).toHaveLength(heads.length);
  for (const count of marked) expect(count).toBeGreaterThan(1); // Assert actual exported marker geometry.
  const preview = await client.callTool({ name: 'preview_diagram', arguments: { diagramId: created.diagramId, maxSize: 1000 } });
  expect(preview.isError).not.toBe(true);
  const image = (preview.content as { type: string; data?: string }[]).find(c => c.type === 'image')!;
  await info.attach('native-endpoint-markers', { body: Buffer.from(image.data!, 'base64'), contentType: 'image/png' });
  const startsRemoved = await apply(client, heads.map(id => ({ op: 'update', id, changes: { startArrowhead: 'none' } })));
  for (const head of heads) expect(element(startsRemoved, head)).toMatchObject({ startArrowhead: null, endArrowhead: head });
  await apply(client, heads.map(id => ({ op: 'update', id, changes: { endArrowhead: 'none' } })));
  expect(await shapesPerLine()).toEqual(heads.map(() => 1));
  const plain = await apply(client, [{ op: 'create_line', id: 'plain', points: [[800, 100], [950, 100]], startArrowhead: 'none', endArrowhead: 'none' }]);
  expect(element(plain, 'plain')).toMatchObject({ type: 'line', startArrowhead: null, endArrowhead: null });
});

test('curved and elbow lines keep markers through rotation, resizing, native undo, copy and reload', async ({ page }) => {
  const client = await connectAgent(page);
  const before = await apply(client, [
    { op: 'create_line', id: 'curve', points: [[180, 200], [360, 340], [540, 200]], routing: 'curved', stroke: '#225566', strokeWidth: 4, strokeStyle: 'dashed' },
    { op: 'update', id: 'curve', changes: { angle: 0.2 } },
    { op: 'create_text', id: 'tag', x: 220, y: 380, text: 'Curve' },
    { op: 'group', ids: ['curve', 'tag'], groupId: 'curve-group' },
    { op: 'create_frame', id: 'frame', ids: ['curve'], background: '#e1ebe5' },
  ]);
  const first = await apply(client, [{ op: 'update', id: 'curve', changes: { startArrowhead: 'crowfoot_one' } }]);
  expect(element(first, 'curve')).toEqual({ ...element(before, 'curve'), type: 'arrow', startArrowhead: 'crowfoot_one' });
  expect(element(first, 'curve').endArrowhead).toBeNull(); // No implicit extra head at the other end.
  const changed = await apply(client, [{ op: 'update', id: 'curve', changes: { endArrowhead: 'crowfoot_many', width: 500, height: 170, angle: 0.4 } }]);
  expect(element(changed, 'curve')).toMatchObject({ id: 'curve', frameId: 'frame', groupIds: ['curve-group'], routing: 'curved', angle: 0.4, stroke: '#225566', strokeWidth: 4, startArrowhead: 'crowfoot_one', endArrowhead: 'crowfoot_many' });
  await undo(page);
  await expect.poll(async () => element(await read(client), 'curve')).toEqual(element(first, 'curve'));
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => element(await read(client), 'curve')).toEqual(element(before, 'curve'));
  await page.keyboard.press('ControlOrMeta+Shift+z'); await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => element(await read(client), 'curve')).toEqual(element(changed, 'curve'));
  const copied = await apply(client, [{ op: 'duplicate', ids: ['frame'], idPrefix: 'copy', dx: 0, dy: 400 }]);
  const copyID = copied.copies.find(c => c.sourceId === 'curve')!.id;
  expect(element(copied, copyID)).toMatchObject({ type: 'arrow', routing: 'curved', startArrowhead: 'crowfoot_one', endArrowhead: 'crowfoot_many' });
  const file = JSON.parse(await exported(client, changed.diagramId));
  expect(file.elements.find((e: any) => e.id === 'curve').roundness).toEqual({ type: 2 });
  const imported = await client.callTool({ name: 'import_diagram', arguments: {
    replaceDiagramId: copied.diagramId, expectedRevision: copied.revision, data: JSON.stringify(file),
  } });
  expect(imported.isError, JSON.stringify(imported.content)).not.toBe(true);
  await page.reload(); await readyCanvas(page, false);
  expect(element(await read(client), 'curve')).toEqual(element(changed, 'curve'));
  const elbow = await apply(client, [{ op: 'create_line', id: 'elbow', points: [[700, 150], [1000, 350]], routing: 'elbow', startArrowhead: 'diamond_outline', endArrowhead: 'circle_outline' }]);
  expect(element(elbow, 'elbow')).toMatchObject({ type: 'arrow', routing: 'elbow', startArrowhead: 'diamond_outline', endArrowhead: 'circle_outline' });
  orthogonal(element(elbow, 'elbow').points!);
  const angular = await apply(client, [{ op: 'update', id: 'elbow', changes: { routing: 'straight' } }]);
  expect(element(angular, 'elbow').points).toHaveLength(2);
  expect(element(angular, 'elbow').endArrowhead).toBe('circle_outline');
});

test('markers on bound straight, curved and elbow paths follow both agent and human edits', async ({ page }) => {
  const client = await connectAgent(page);
  const initial = await apply(client, [
    { op: 'create_shape', id: 'a', shape: 'rectangle', x: 200, y: 200, width: 150, height: 80 },
    { op: 'create_shape', id: 'b', shape: 'rectangle', x: 600, y: 200, width: 150, height: 80 },
    { op: 'create_shape', id: 'c', shape: 'rectangle', x: 600, y: 480, width: 150, height: 100 },
    { op: 'connect', id: 'straight', fromId: 'a', toId: 'b', startArrowhead: 'crowfoot_one', endArrowhead: 'crowfoot_many' },
    { op: 'connect', id: 'elbow', fromId: 'b', toId: 'c', routing: 'elbow', startArrowhead: 'circle_outline', endArrowhead: 'crowfoot_one_or_many' },
    { op: 'create_line', id: 'curve', points: [[280, 290], [300, 520], [590, 530]], routing: 'curved' },
    { op: 'update', id: 'curve', changes: { fromId: 'a', toId: 'c', startArrowhead: 'diamond_outline', endArrowhead: 'triangle_outline' } },
  ]);
  expect(initial.elements).toHaveLength(6);
  const edited = await apply(client, [
    { op: 'update', id: 'c', changes: { width: 180, height: 130, angle: 0.15 } },
    { op: 'update', id: 'elbow', changes: { strokeWidth: 5, strokeStyle: 'dotted' } },
  ]);
  const canvas = await page.getByTestId('editor').boundingBox();
  if (!canvas) throw new Error('Missing canvas');
  await page.keyboard.press('v');
  await page.mouse.move(canvas.x + 625, canvas.y + 225); await page.mouse.down();
  await page.mouse.move(canvas.x + 695, canvas.y + 275, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => element(await read(client), 'b').x).toBeGreaterThan(650);
  const human = await read(client);
  expect(element(human, 'straight').points).not.toEqual(element(edited, 'straight').points);
  expect(element(human, 'elbow').points).not.toEqual(element(edited, 'elbow').points);
  orthogonal(element(human, 'elbow').points!);
  for (const id of ['straight', 'curve', 'elbow']) {
    const original = element(initial, id);
    expect(element(human, id)).toMatchObject({ fromId: original.fromId, toId: original.toId, startArrowhead: original.startArrowhead, endArrowhead: original.endArrowhead, routing: original.routing });
  }
  const detached = await apply(client, [{ op: 'update', id: 'curve', changes: { fromId: null, startArrowhead: 'none' } }]);
  const freeStart = element(detached, 'curve').points![0];
  const moved = await apply(client, [{ op: 'move', id: 'c', x: 700, y: 520 }]);
  expect(element(moved, 'curve')).toMatchObject({ fromId: null, toId: 'c', startArrowhead: null, endArrowhead: 'triangle_outline', routing: 'curved' });
  expect(element(moved, 'curve').points![0]).toEqual(freeStart);
});

test('invalid edits never partially upgrade lines or discard filled closed paths', async ({ page }) => {
  const client = await connectAgent(page);
  const before = await apply(client, [
    { op: 'create_line', id: 'plain', points: [[100, 100], [300, 150]] },
    { op: 'create_line', id: 'filled', points: [[100, 300], [300, 300], [300, 500], [100, 300]], fill: '#e1ebe5', fillStyle: 'solid' },
    { op: 'create_shape', id: 'box', shape: 'rectangle', x: 400, y: 300 },
  ]);
  for (const operation of [
    { op: 'update', id: 'box', changes: { endArrowhead: 'crowfoot_many' } },
    { op: 'update', id: 'filled', changes: { endArrowhead: 'crowfoot_many' } },
    { op: 'update', id: 'plain', changes: { fromId: 'missing' } },
    { op: 'create_line', id: 'bad', points: [[500, 500], [550, 500], [550, 550], [500, 500]], fill: '#ffffff', endArrowhead: 'arrow' },
  ]) {
    const result = await client.callTool({ name: 'apply_operations', arguments: {
      diagramId: before.diagramId, expectedRevision: before.revision,
      operations: [{ op: 'update', id: 'plain', changes: { startArrowhead: 'crowfoot_one' } }, operation],
    } });
    expect(result.isError).toBe(true);
    expect(await read(client)).toMatchObject({ revision: before.revision, elements: before.elements });
  }
  const cleared = await apply(client, [{ op: 'update', id: 'filled', changes: { fill: 'transparent', endArrowhead: 'arrow' } }]);
  expect(element(cleared, 'filled')).toMatchObject({ type: 'arrow', fill: 'transparent', endArrowhead: 'arrow' });
});
