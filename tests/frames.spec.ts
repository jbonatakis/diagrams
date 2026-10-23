import { test, expect, type Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent, readyCanvas } from './connection-helpers';
import type { DiagramSnapshot } from '../src/editor/controller';
import type { Operation } from '../src/protocol';

test.setTimeout(60_000);
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
const order = (state: DiagramSnapshot) => state.elements.map(e => e.id);
async function rawScene(client: Client, diagramId: string) {
  const result = await client.callTool({ name: 'export_diagram', arguments: { diagramId } });
  expect(result.isError).not.toBe(true);
  const first = result.structuredContent as { artifactId: string; data: string; nextOffset: number | null };
  let data = first.data, offset = first.nextOffset;
  while (offset !== null) {
    const result = await client.callTool({ name: 'read_export', arguments: { artifactId: first.artifactId, offset } });
    expect(result.isError).not.toBe(true);
    const next = result.structuredContent as { data: string; nextOffset: number | null };
    data += next.data; offset = next.nextOffset;
  }
  await client.callTool({ name: 'release_transfer', arguments: { transferId: first.artifactId } });
  return JSON.parse(data);
}
async function history(page: Page, redo = false) {
  // Focus the editor without selecting content or creating a history entry.
  await page.locator('.excalidraw.excalidraw-container').focus();
  await page.keyboard.press(redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
}
const boxes: Operation[] = [
  { op: 'create_shape', id: 'a', shape: 'rectangle', x: 200, y: 150, width: 180, height: 100, label: 'Browser' },
  { op: 'create_shape', id: 'b', shape: 'rectangle', x: 600, y: 150, width: 180, height: 100, label: 'Agent' },
  { op: 'connect', id: 'link', fromId: 'a', toId: 'b', label: 'Messages' },
];

test('frames and backgrounds preserve content, earlier history, previews, export and reload', async ({ page }, testInfo) => {
  const client = await connectAgent(page);
  await apply(client, [...boxes, { op: 'group', ids: ['a', 'b'], groupId: 'tables' }]);
  // Native history recalculates bound arrow endpoints (including stroke gaps).
  // Establish the baseline through native undo/redo so the frame test compares
  // against that geometry, while still requiring exact restoration afterward.
  await history(page);
  await expect.poll(async () => (await read(client)).elements.length).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => order(await read(client))).toEqual(['a', 'b', 'link']);
  const before = await read(client);
  const framed = await apply(client, [
    { op: 'create_frame', id: 'frame', ids: ['a'], name: 'Connection', padding: 40, background: '#e1e8e5' },
    { op: 'set_background', color: '#f6f5f0' },
  ]);
  const frame = element(framed, 'frame'), bg = frame.backgroundId!;
  expect(frame).toMatchObject({ name: 'Connection', frameId: null, x: 160, y: 110, width: 660, height: 180 });
  expect(frame.memberIds).toEqual(expect.arrayContaining(['a', 'b', 'link']));
  expect(frame.memberIds).toHaveLength(3);
  expect(order(framed)).toEqual([bg, 'a', 'b', 'link', 'frame']);
  expect(element(framed, bg)).toMatchObject({ frameId: 'frame', fill: '#e1e8e5', locked: true });
  for (const e of before.elements) expect(element(framed, e.id)).toMatchObject({ ...e, frameId: 'frame' });
  const file = await rawScene(client, framed.diagramId);
  expect(file.appState.viewBackgroundColor).toBe('#f6f5f0');
  for (const e of file.elements.filter((e: any) => e.id !== 'frame')) expect(e.frameId).toBe('frame');
  expect(file.elements.find((e: any) => e.id === bg).customData.diagramsFrameBackground).toBe(true);
  const preview = await client.callTool({ name: 'preview_diagram', arguments: { diagramId: framed.diagramId, elementIds: ['frame'], maxSize: 800 } });
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  expect(preview.structuredContent).toMatchObject({ elementIds: [bg, 'a', 'b', 'link', 'frame'] });
  const image = (preview.content as { type: string; data?: string }[]).find(c => c.type === 'image')!;
  await testInfo.attach('framed-diagram', { body: Buffer.from(image.data!, 'base64'), contentType: 'image/png' });
  await history(page);
  await expect.poll(async () => (await read(client)).elements).toEqual(before.elements);
  expect((await read(client)).backgroundColor).toBe(before.backgroundColor);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await read(client)).elements.length).toBe(0); // History before the frame survives.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await read(client)).elements).toEqual(framed.elements);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  await page.reload(); await readyCanvas(page, false);
  expect((await read(client)).elements).toEqual(framed.elements);
  expect((await read(client)).backgroundColor).toBe('#f6f5f0');
});

test('frame moves, refits, copies and removal keep membership, backgrounds and bindings consistent', async ({ page }) => {
  const client = await connectAgent(page);
  const initial = await apply(client, [...boxes, { op: 'create_frame', id: 'frame', ids: ['a', 'b'], background: '#e1e8e5' }]);
  const moved = await apply(client, [{ op: 'translate', ids: ['frame', 'a'], dx: 30, dy: 60 }]);
  for (const e of initial.elements) {
    expect(element(moved, e.id).x).toBeCloseTo(e.x + 30);
    expect(element(moved, e.id).y).toBeCloseTo(e.y + 60);
  }
  const updated = await apply(client, [
    { op: 'move', id: 'b', x: 700, y: 250 },
    { op: 'update_frame', id: 'frame', padding: 80, name: 'Moved', background: '#cceedd' },
  ]);
  const frame = element(updated, 'frame'), bg = element(updated, frame.backgroundId!);
  expect(frame).toMatchObject({ x: 150, y: 130, width: 810, height: 300, name: 'Moved' });
  expect(bg).toMatchObject({ x: frame.x, y: frame.y, width: frame.width, height: frame.height, fill: '#cceedd' });
  const copied = await apply(client, [{ op: 'duplicate', ids: ['frame'], idPrefix: 'copy', dx: 0, dy: 400 }]);
  const id = (sourceId: string) => copied.copies.find(c => c.sourceId === sourceId)!.id;
  expect(element(copied, id('frame'))).toMatchObject({ backgroundId: id(bg.id), name: 'Moved' });
  expect(element(copied, id('link'))).toMatchObject({ fromId: id('a'), toId: id('b'), frameId: id('frame') });
  const dissolved = await apply(client, [{ op: 'remove_frame', id: 'frame' }]);
  expect(order(dissolved)).not.toContain('frame'); expect(order(dissolved)).not.toContain(bg.id);
  expect(element(dissolved, 'a').frameId).toBeNull();
  expect(element(dissolved, 'link')).toMatchObject({ fromId: 'a', toId: 'b', frameId: null });
  await history(page);
  await expect.poll(async () => order(await read(client))).toEqual(order(copied));
  const deleted = await apply(client, [{ op: 'delete', ids: [id('frame')] }]);
  expect(order(deleted)).toEqual(order(updated));
  const noFill = await apply(client, [{ op: 'update_frame', id: 'frame', background: null }]);
  expect(element(noFill, 'frame').backgroundId).toBeNull();
  expect(order(noFill)).not.toContain(bg.id);
});

test('layer order preserves groups, bound labels and frame boundaries through undo and reload', async ({ page }) => {
  const client = await connectAgent(page);
  const start = await apply(client, [...boxes, { op: 'group', ids: ['a', 'b'], groupId: 'pair' },
    { op: 'create_shape', id: 'cover', shape: 'rectangle', x: 300, y: 200 },
    { op: 'create_text', id: 'caption', x: 300, y: 350, text: 'Caption' },
  ]);
  const front = await apply(client, [{ op: 'reorder', ids: ['a'], position: 'front' }]);
  expect(order(front)).toEqual(['link', 'cover', 'caption', 'a', 'b']);
  const file = await rawScene(client, front.diagramId);
  const rawIDs = file.elements.map((e: any) => e.id);
  for (const id of ['a', 'b']) {
    const label = file.elements.find((e: any) => e.containerId === id);
    expect(rawIDs.indexOf(label.id)).toBe(rawIDs.indexOf(id) + 1);
  }
  await history(page);
  await expect.poll(async () => order(await read(client))).toEqual(order(start));
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => order(await read(client))).toEqual(order(front));
  expect(order(await apply(client, [{ op: 'reorder', ids: ['a'], position: 'backward' }]))).toEqual(['link', 'cover', 'a', 'b', 'caption']);
  expect(order(await apply(client, [{ op: 'reorder', ids: ['a'], position: 'forward' }]))).toEqual(order(front));
  expect(order(await apply(client, [{ op: 'reorder', ids: ['a'], position: 'back' }]))).toEqual(['a', 'b', 'link', 'cover', 'caption']);
  const framed = await apply(client, [{ op: 'create_frame', id: 'frame', ids: ['a', 'b'], background: '#dddddd' }]);
  const bg = element(framed, 'frame').backgroundId!;
  const inside = await apply(client, [{ op: 'reorder', ids: ['a'], position: 'front' }]);
  expect(order(inside)).toEqual([bg, 'link', 'a', 'b', 'frame', 'cover', 'caption']);
  const onTop = await apply(client, [{ op: 'reorder', ids: ['frame'], position: 'front' }]);
  expect(order(onTop)).toEqual(['cover', 'caption', bg, 'link', 'a', 'b', 'frame']);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  await page.reload(); await readyCanvas(page, false);
  expect(order(await read(client))).toEqual(order(onTop));
});

test('invalid frame batches are atomic and canvas background supports undo, retry and conflict checks', async ({ page }) => {
  const client = await connectAgent(page);
  const before = await apply(client, [...boxes, { op: 'create_frame', id: 'frame', ids: ['a'], background: '#eeeeee' }]);
  for (const operation of [
    { op: 'create_frame', id: 'nested', ids: ['frame'] },
    { op: 'create_frame', id: 'duplicate', ids: ['a'] },
    { op: 'reorder', ids: ['a', 'b'], position: 'front' },
    { op: 'reorder', ids: [element(before, 'frame').backgroundId!], position: 'front' },
    { op: 'update_frame', id: 'a', padding: 20 },
    { op: 'group', ids: ['a', 'b'], groupId: 'mixed' },
  ]) {
    const result = await client.callTool({ name: 'apply_operations', arguments: { diagramId: before.diagramId, expectedRevision: before.revision,
      operations: [{ op: 'set_background', color: '#112233' }, { op: 'update_frame', id: 'frame', name: 'Must not persist' }, operation] } });
    expect(result.isError).toBe(true);
    expect(await read(client)).toMatchObject({ elements: before.elements, revision: before.revision, backgroundColor: before.backgroundColor });
  }
  const args = { diagramId: before.diagramId, expectedRevision: before.revision, requestId: crypto.randomUUID(), operations: [{ op: 'set_background', color: '#ffeecc' }] };
  const changed = await client.callTool({ name: 'apply_operations', arguments: args });
  expect(changed.isError).not.toBe(true);
  expect((await read(client)).backgroundColor).toBe('#ffeecc');
  const retry = await client.callTool({ name: 'apply_operations', arguments: args });
  expect(retry.structuredContent).toMatchObject({ replayed: true });
  const conflict = await client.callTool({ name: 'apply_operations', arguments: { ...args, requestId: crypto.randomUUID() } });
  expect(conflict.isError).toBe(true);
  await history(page);
  await expect.poll(async () => (await read(client)).backgroundColor).toBe(before.backgroundColor);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await read(client)).backgroundColor).toBe('#ffeecc');

  const current = await read(client), file = await rawScene(client, current.diagramId);
  file.elements.find((e: any) => e.id === 'a').locked = true;
  const imported = await client.callTool({ name: 'import_diagram', arguments: {
    replaceDiagramId: current.diagramId, expectedRevision: current.revision, data: JSON.stringify(file),
  } });
  expect(imported.isError).not.toBe(true);
  const locked = await read(client);
  for (const operation of [
    { op: 'translate', ids: ['frame'], dx: 50, dy: 20 },
    { op: 'delete', ids: ['frame'] },
    { op: 'remove_frame', id: 'frame' },
    { op: 'reorder', ids: ['frame'], position: 'front' },
  ]) {
    const result = await client.callTool({ name: 'apply_operations', arguments: {
      diagramId: locked.diagramId, expectedRevision: locked.revision, operations: [operation],
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('element_locked');
    expect((await read(client)).elements).toEqual(locked.elements);
  }
});
