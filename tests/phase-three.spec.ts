import { test, expect, type Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent, readyCanvas } from './connection-helpers';
import type { DiagramSnapshot } from '../src/editor/controller';
import type { ApplyArguments, Operation } from '../src/protocol';

test.setTimeout(60_000);
type Applied = DiagramSnapshot & { copies: { sourceId: string; id: string }[]; replayed: boolean; appliedRevision: number };
async function read(client: Client): Promise<DiagramSnapshot> {
  const r = await client.callTool({ name: 'get_diagram', arguments: {} });
  expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
  return r.structuredContent as DiagramSnapshot;
}
async function apply(client: Client, operations: Operation[], extra: Partial<ApplyArguments> = {}): Promise<Applied> {
  const state = await read(client);
  const r = await client.callTool({ name: 'apply_operations', arguments: { diagramId: state.diagramId, expectedRevision: state.revision, requestId: crypto.randomUUID(), operations, ...extra } });
  expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
  return r.structuredContent as Applied;
}
const element = (state: DiagramSnapshot, id: string) => state.elements.find(e => e.id === id)!;
const base: Operation[] = [
  { op: 'create_shape', id: 'a', shape: 'rectangle', x: 240, y: 200, width: 180, height: 100, label: 'Browser' },
  { op: 'create_shape', id: 'b', shape: 'ellipse', x: 650, y: 200, width: 180, height: 100, label: 'Agent' },
];
async function undo(page: Page) {
  await page.getByTestId('editor').click({ position: { x: 900, y: 650 } });
  await page.keyboard.press('ControlOrMeta+z');
}
async function rawScene(client: Client, diagramId: string) {
  const result = await client.callTool({ name: 'export_diagram', arguments: { diagramId } });
  expect(result.isError).not.toBe(true);
  const first = result.structuredContent as { artifactId: string; data: string; nextOffset: number | null };
  let data = first.data, offset = first.nextOffset;
  while (offset !== null) {
    const chunk = await client.callTool({ name: 'read_export', arguments: { artifactId: first.artifactId, offset } });
    const next = chunk.structuredContent as { data: string; nextOffset: number | null };
    data += next.data; offset = next.nextOffset;
  }
  await client.callTool({ name: 'release_transfer', arguments: { transferId: first.artifactId } });
  return JSON.parse(data);
}
function orthogonal(points: number[][]) {
  expect(points.length).toBeGreaterThanOrEqual(2);
  points.slice(1).forEach((p, i) => expect(Math.min(Math.abs(p[0] - points[i][0]), Math.abs(p[1] - points[i][1]))).toBeLessThan(0.001));
}

test('direct edits reflow labels and standalone text, preserve style, and undo as one batch', async ({ page }) => {
  const client = await connectAgent(page);
  const initial = await apply(client, [...base,
    { op: 'create_text', id: 'title', x: 240, y: 60, text: 'A useful diagram', fontSize: 28 },
    { op: 'create_line', id: 'rule', points: [[240, 125], [830, 125]], strokeStyle: 'dotted' },
  ]);
  const changed = await apply(client, [
    { op: 'update', id: 'a', changes: { text: 'A much longer browser label', width: 280, height: 120, fontSize: 24, fill: '#ffddaa', stroke: '#441122', strokeStyle: 'dashed', strokeWidth: 4, opacity: 80 } },
    { op: 'update', id: 'b', changes: { angle: Math.PI / 6, text: 'New agent' } },
    { op: 'update', id: 'title', changes: { text: 'A revised title with wrapping', width: 220, fontSize: 30 } },
    { op: 'update', id: 'rule', changes: { points: [[220, 140], [850, 140]], strokeWidth: 5 } },
  ]);
  expect(element(changed, 'a')).toMatchObject({ text: 'A much longer browser label', width: 280, fontSize: 24, fill: '#ffddaa', strokeStyle: 'dashed', strokeWidth: 4, opacity: 80 });
  expect(element(changed, 'b').angle).toBeCloseTo(Math.PI / 6);
  expect(element(changed, 'title').height).toBeGreaterThan(element(initial, 'title').height);
  expect(element(changed, 'rule').points).toEqual([[220, 140], [850, 140]]);
  const file = await rawScene(client, changed.diagramId);
  const label = file.elements.find((e: any) => e.type === 'text' && e.containerId === 'a');
  const shape = file.elements.find((e: any) => e.id === 'a');
  expect(label.x).toBeGreaterThanOrEqual(shape.x);
  expect(label.x + label.width).toBeLessThanOrEqual(shape.x + shape.width + 0.01);
  expect(label.y + label.height).toBeLessThanOrEqual(shape.y + shape.height + 0.01);
  await undo(page);
  await expect.poll(async () => (await read(client)).elements).toEqual(initial.elements);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => element(await read(client), 'a').text).toBe('A much longer browser label');
  await page.reload(); await readyCanvas(page, false);
  expect(element(await read(client), 'a')).toMatchObject({ text: 'A much longer browser label', width: 280, fontSize: 24 });
});

test('straight and elbow connectors follow resize, rotation, human moves, and endpoint edits', async ({ page }) => {
  const client = await connectAgent(page);
  await apply(client, [...base,
    { op: 'create_shape', id: 'c', shape: 'diamond', x: 650, y: 460, width: 180, height: 120, label: 'Storage' },
    { op: 'connect', id: 'straight', fromId: 'a', toId: 'b', label: 'Reads' },
    { op: 'connect', id: 'elbow', fromId: 'a', toId: 'c', routing: 'elbow', label: 'Saves' },
  ]);
  orthogonal(element(await read(client), 'elbow').points!);
  const updated = await apply(client, [
    { op: 'update', id: 'a', changes: { width: 240, height: 130, angle: 0.2 } },
    { op: 'update', id: 'straight', changes: { text: 'Sends updates', startArrowhead: 'triangle', endArrowhead: 'bar', strokeStyle: 'dashed', toId: 'c' } },
    { op: 'move', id: 'c', x: 700, y: 430 },
  ]);
  expect(element(updated, 'straight')).toMatchObject({ fromId: 'a', toId: 'c', text: 'Sends updates', startArrowhead: 'triangle', endArrowhead: 'bar' });
  orthogonal(element(updated, 'elbow').points!);
  const box = await page.getByTestId('editor').boundingBox();
  if (!box) throw new Error('Missing canvas');
  await page.keyboard.press('v');
  await page.mouse.move(box.x + 735, box.y + 480); await page.mouse.down();
  await page.mouse.move(box.x + 785, box.y + 520, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => element(await read(client), 'c').x).toBeGreaterThan(720);
  const human = await read(client);
  orthogonal(element(human, 'elbow').points!);
  expect(element(human, 'elbow').points).not.toEqual(element(updated, 'elbow').points);
  const detached = await apply(client, [{ op: 'update', id: 'straight', changes: { toId: null, text: '' } }]);
  expect(element(detached, 'straight')).toMatchObject({ fromId: 'a', toId: null });
  expect(element(detached, 'straight').text).toBeUndefined();
  const moved = await apply(client, [{ op: 'move', id: 'a', x: 200, y: 330 }]);
  expect(element(moved, 'straight').fromId).toBe('a');
  const beforeEnd = element(detached, 'straight').points!.at(-1)!;
  const afterEnd = element(moved, 'straight').points!.at(-1)!;
  expect(afterEnd[0]).toBeCloseTo(beforeEnd[0], 5); expect(afterEnd[1]).toBeCloseTo(beforeEnd[1], 5);
  orthogonal(element(moved, 'elbow').points!);
});

test('groups duplicate with independent labels and connectors, delete and undo restore the branch', async ({ page }) => {
  const client = await connectAgent(page);
  await apply(client, [...base, { op: 'connect', id: 'link', fromId: 'a', toId: 'b', label: 'Connected' },
    { op: 'group', ids: ['a', 'b', 'link'], groupId: 'original-group' }]);
  const copied = await apply(client, [{ op: 'duplicate', ids: ['a', 'b'], idPrefix: 'copy', dx: 0, dy: 330 }]);
  const id = (source: string) => copied.copies.find(c => c.sourceId === source)!.id;
  expect(element(copied, id('link'))).toMatchObject({ fromId: id('a'), toId: id('b'), text: 'Connected' });
  expect(element(copied, id('a')).groupIds).not.toEqual(['original-group']);
  expect(element(copied, id('a')).groupIds).toEqual(element(copied, id('b')).groupIds);
  await apply(client, [{ op: 'ungroup', groupIds: [...element(copied, id('a')).groupIds] },
    { op: 'translate', ids: [id('a'), id('b'), id('link')], dx: 70, dy: 20 }]);
  const before = await read(client);
  expect(element(before, id('a')).x).toBe(element(before, 'a').x + 70);
  const deleted = await apply(client, [{ op: 'delete', ids: [id('a')] }]);
  expect(deleted.elements.some(e => e.id === id('link'))).toBe(false);
  expect(deleted.elements.some(e => e.id === 'link')).toBe(true);
  await undo(page);
  await expect.poll(async () => (await read(client)).elements.map(e => e.id)).toEqual(before.elements.map(e => e.id));
  const restored = await read(client);
  expect(element(restored, id('link'))).toMatchObject({ fromId: id('a'), toId: id('b'), text: 'Connected' });
  const file = await rawScene(client, restored.diagramId);
  for (const e of file.elements.filter((e: any) => e.type === 'text' && !e.isDeleted)) expect(file.elements.some((c: any) => !c.isDeleted && c.id === e.containerId)).toBe(true);
});

test('alignment and equal-gap distribution preserve endpoints and fail atomically without enough space', async ({ page }) => {
  const client = await connectAgent(page);
  await apply(client, [
    { op: 'create_shape', id: 'a', shape: 'rectangle', x: 100, y: 200, width: 100, height: 80 },
    { op: 'create_shape', id: 'b', shape: 'rectangle', x: 330, y: 280, width: 200, height: 80 },
    { op: 'create_shape', id: 'c', shape: 'rectangle', x: 800, y: 350, width: 150, height: 80 },
    { op: 'connect', id: 'link', fromId: 'a', toId: 'b', routing: 'elbow' },
  ]);
  const aligned = await apply(client, [{ op: 'align', ids: ['a', 'b', 'c'], alignment: 'top' }, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' }]);
  const [a, b, c] = ['a', 'b', 'c'].map(id => element(aligned, id));
  expect(a.y).toBe(200); expect(b.y).toBe(200); expect(c.y).toBe(200);
  expect(b.x - a.x - a.width).toBeCloseTo(c.x - b.x - b.width, 8);
  expect(a.x).toBe(100); expect(c.x).toBe(800);
  orthogonal(element(aligned, 'link').points!);
  const invalid = await client.callTool({ name: 'apply_operations', arguments: { diagramId: aligned.diagramId, expectedRevision: aligned.revision,
    operations: [{ op: 'move', id: 'b', x: 330, y: 200 }, { op: 'move', id: 'c', x: 150, y: 200 }, { op: 'distribute', ids: ['a', 'b', 'c'], axis: 'horizontal' }] } });
  expect(invalid.isError).toBe(true);
  expect((await read(client)).elements).toEqual(aligned.elements);
});

test('saved request IDs prevent duplicate retries across human edits, undo, and reload', async ({ page }) => {
  const client = await connectAgent(page);
  const start = await apply(client, base);
  const args: ApplyArguments = { diagramId: start.diagramId, expectedRevision: start.revision, requestId: crypto.randomUUID(), operations: [{ op: 'duplicate', ids: ['a'], idPrefix: 'once' }] };
  const first = await client.callTool({ name: 'apply_operations', arguments: args });
  expect(first.isError).not.toBe(true);
  const count = (first.structuredContent as Applied).elements.length;
  // A real human edit changes the document revision between calls.
  await page.getByLabel('Diagram name', { exact: true }).fill('Human renamed this');
  await page.getByLabel('Diagram name', { exact: true }).press('Enter');
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  const retry = await client.callTool({ name: 'apply_operations', arguments: args });
  expect(retry.isError).not.toBe(true);
  expect(retry.structuredContent).toMatchObject({ replayed: true, name: 'Human renamed this' });
  expect((retry.structuredContent as Applied).elements).toHaveLength(count);
  await undo(page);
  await expect.poll(async () => (await read(client)).elements.length).toBe(start.elements.length);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  await page.reload(); await readyCanvas(page, false);
  const again = await client.callTool({ name: 'apply_operations', arguments: args });
  expect(again.isError).not.toBe(true);
  expect(again.structuredContent).toMatchObject({ replayed: true });
  expect((again.structuredContent as Applied).elements).toHaveLength(start.elements.length);
  const conflict = await client.callTool({ name: 'apply_operations', arguments: { ...args, operations: [{ op: 'delete', ids: ['a'] }] } });
  expect(conflict.isError).toBe(true); expect(JSON.stringify(conflict.content)).toContain('request_id_conflict');
});

test('locked attached arrows and invalid properties reject the whole batch', async ({ page }) => {
  const client = await connectAgent(page);
  const start = await apply(client, [...base, { op: 'connect', id: 'locked-link', fromId: 'a', toId: 'b' }]);
  const file = await rawScene(client, start.diagramId);
  file.elements.find((e: any) => e.id === 'locked-link').locked = true;
  const imported = await client.callTool({ name: 'import_diagram', arguments: { replaceDiagramId: start.diagramId, expectedRevision: start.revision, data: JSON.stringify(file) } });
  expect(imported.isError).not.toBe(true);
  const before = await read(client);
  for (const operations of [
    [{ op: 'create_text', id: 'no-side-effect', x: 0, y: 0, text: 'Must not appear' }, { op: 'update', id: 'a', changes: { width: 300 } }],
    [{ op: 'update', id: 'a', changes: { startArrowhead: 'arrow' } }],
    [{ op: 'delete', ids: ['a'] }],
  ]) {
    const result = await client.callTool({ name: 'apply_operations', arguments: { diagramId: before.diagramId, expectedRevision: before.revision, operations } });
    expect(result.isError).toBe(true);
    expect((await read(client)).elements).toEqual(before.elements);
  }
});

test('previews return MCP image content and fitting leaves the last edit undoable', async ({ page }, testInfo) => {
  const client = await connectAgent(page);
  const created = await apply(client, base);
  const preview = await client.callTool({ name: 'preview_diagram', arguments: { diagramId: created.diagramId, maxSize: 512 } });
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  const image = (preview.content as { type: string; data?: string; mimeType?: string }[]).find(c => c.type === 'image')!;
  expect(image.mimeType).toBe('image/png');
  const bytes = Buffer.from(image.data!, 'base64');
  await testInfo.attach('agent-preview', { body: bytes, contentType: 'image/png' });
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(512); expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(512);
  expect(preview.structuredContent).not.toHaveProperty('data');
  expect(preview.structuredContent).toMatchObject({ revision: created.revision, elementIds: ['a', 'b'] });
  const box = await page.getByTestId('editor').boundingBox();
  if (!box) throw new Error('Missing canvas');
  await page.keyboard.press('v'); await page.mouse.click(box.x + 265, box.y + 225);
  await expect.poll(async () => (await read(client)).selectedElementIds).toContain('a');
  const selected = await client.callTool({ name: 'preview_diagram', arguments: { diagramId: created.diagramId, selectionOnly: true, maxSize: 512 } });
  expect(selected.isError).not.toBe(true); expect(selected.structuredContent).toMatchObject({ elementIds: ['a'] });
  // Excalidraw records human selection changes in native history. Establish a
  // real edit after selecting, then undo without clicking and changing selection.
  const edited = await apply(client, [{ op: 'update', id: 'b', changes: { fill: '#ffddaa' } }]);
  const fit = await client.callTool({ name: 'fit_canvas', arguments: { diagramId: created.diagramId, elementIds: ['a'] } });
  expect(fit.isError).not.toBe(true);
  const after = await read(client);
  expect(after.elements).toEqual(edited.elements); expect(after.revision).toBe(edited.revision);
  expect(after.viewport).not.toEqual(created.viewport);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => element(await read(client), 'b').fill).toBe(element(created, 'b').fill);
});
