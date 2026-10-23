import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent } from './connection-helpers';
import { estimatedStorageBytes, formatStorageSize } from '../src/library/size';

let client: Client;
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) {
    await page.keyboard.press('Escape');
    // The mobile library overlays the agent sidebar until it is closed.
    const closeDiagrams = page.getByRole('button', { name: 'Close diagrams', exact: true });
    if (await closeDiagrams.isVisible().catch(() => false)) await closeDiagrams.click();
    const disconnect = page.getByRole('button', { name: 'Pause agent access', exact: true });
    if (await disconnect.isVisible().catch(() => false)) await disconnect.click();
  }
  await client?.close();
  expect(errors).toEqual([]);
});
async function connect(page: Page, navigate = true) {
  client = await connectAgent(page, navigate);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent;
}
async function fails(name: string, args: Record<string, unknown>, code: string) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(code);
}
async function open(diagramId: string) {
  const current = await call('get_diagram');
  return call('open_diagram', { diagramId, expectedActiveDiagramId: current.diagramId, expectedActiveRevision: current.revision });
}
async function sample() {
  const current = await call('get_diagram');
  return call('apply_operations', { diagramId: current.diagramId, expectedRevision: current.revision, operations: [
    { op: 'create_shape', id: 'box', shape: 'rectangle', x: 250, y: 230, width: 180, height: 100, label: 'Client 🌿' },
    { op: 'create_shape', id: 'circle', shape: 'ellipse', x: 650, y: 230, width: 180, height: 100, label: 'Agent' },
    { op: 'connect', id: 'arrow', fromId: 'box', toId: 'circle', strokeStyle: 'dotted', strokeWidth: 4, startArrowhead: 'arrow', endArrowhead: 'triangle' },
  ] });
}
async function exported(name: string, args: Record<string, unknown> = {}) {
  const file = await call(name, args);
  let next = file.nextOffset;
  const parts = [file.data];
  while (next !== null) {
    const chunk = await call('read_export', { artifactId: file.artifactId, offset: next });
    parts.push(chunk.data); next = chunk.nextOffset;
  }
  await call('release_transfer', { transferId: file.artifactId });
  return { ...file, data: parts.join('') };
}
async function upload(kind: string, data: string) {
  const { uploadId } = await call('begin_import', { kind });
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + 15_000, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
    const next = await call('write_import_chunk', { uploadId, offset, data: data.slice(offset, end) });
    expect(next.nextOffset).toBe(end); offset = end;
  }
  return uploadId;
}
const empty = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} });

// Reads the actual storage, without exposing an application testing API.
async function stored(page: Page, id: string) {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('diagrams'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(['diagrams', 'scenes', 'recovery']);
    const get = (store: string) => new Promise<any>((resolve) => { const r = tx.objectStore(store).get(key); r.onsuccess = () => resolve(r.result); });
    const [meta, scene, recovery] = await Promise.all([get('diagrams'), get('scenes'), get('recovery')]); db.close();
    return { meta, scene, recovery };
  }, id);
}

function measuredSize(disk: Awaited<ReturnType<typeof stored>>) {
  const { storageSize: _size, ...meta } = disk.meta;
  return {
    sceneBytes: Buffer.byteLength(JSON.stringify(disk.scene)),
    recoveryBytes: disk.recovery === undefined ? 0 : Buffer.byteLength(JSON.stringify(disk.recovery)),
    metadataBytes: Buffer.byteLength(JSON.stringify(meta)),
  };
}

async function trashWithRecovery(name: string) {
  const active = await call('get_diagram');
  const copy = await call('manage_diagram', { diagramId: active.diagramId, expectedRevision: active.revision, action: 'duplicate', name });
  const replaced = await call('import_diagram', { data: empty, replaceDiagramId: copy.id, expectedRevision: copy.revision });
  return call('manage_diagram', { diagramId: copy.id, expectedRevision: replaced.revision, action: 'trash' });
}
const deletionTarget = (item: { id: string; revision: number }) => ({ diagramId: item.id, expectedRevision: item.revision });
const removedRecords = { meta: undefined, scene: undefined, recovery: undefined };

test('trash can be permanently cleared individually or in full, with confirmation and updated sizes', async ({ page }, info) => {
  await connect(page); const active = await sample();
  const first = await trashWithRecovery('Trash one');
  const second = await trashWithRecovery('Trash two');
  const third = await trashWithRecovery('Hidden by search');
  const original = await stored(page, first.id);
  expect(original.recovery.elements.length).toBeGreaterThan(0);
  const beforeTotal = (await call('list_diagrams', { includeTrash: true })).diagrams.reduce((sum: number, item: any) => sum + estimatedStorageBytes(item.storageSize), 0);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Your diagrams' });
  await panel.locator('.library-tabs').getByRole('button', { name: 'Trash', exact: true }).click();
  const firstRow = panel.locator('li').filter({ has: page.getByText('Trash one', { exact: true }) });
  const dialog = page.getByRole('dialog');
  await firstRow.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog).toContainText('Trash one');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await stored(page, first.id)).toEqual(original);
  await firstRow.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await call('manage_diagram', { ...deletionTarget(first), action: 'rename', name: first.name });
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed');
  expect((await stored(page, first.id)).meta).toBeTruthy();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await firstRow.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(firstRow).toHaveCount(0);
  expect(await stored(page, first.id)).toEqual(removedRecords);

  await panel.getByLabel('Search diagrams').fill('Trash two');
  await expect(panel.locator('.diagram-list li')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(dialog).toContainText('all 2 diagrams');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await stored(page, second.id)).meta).toBeTruthy();
  expect((await stored(page, third.id)).meta).toBeTruthy();
  await panel.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await page.screenshot({ path: info.outputPath('empty-trash-confirmation.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Empty trash', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('empty-trash-mobile.png') });
  await dialog.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText('No diagrams in the trash.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Empty trash', exact: true })).toBeDisabled();
  for (const item of [second, third]) expect(await stored(page, item.id)).toEqual(removedRecords);
  const remaining = (await call('list_diagrams', { includeTrash: true })).diagrams;
  expect(remaining.map((item: any) => item.id)).toEqual([active.diagramId]);
  const total = estimatedStorageBytes(remaining[0].storageSize);
  expect(total).toBeLessThan(beforeTotal);
  await expect(panel.getByTestId('library-storage-total')).toHaveText(`~${formatStorageSize(total)}`);
  expect((await call('get_diagram')).elements).toEqual(active.elements);
  await page.reload(); await connect(page, false);
  expect((await call('list_diagrams', { includeTrash: true })).diagrams.map((item: any) => item.id)).toEqual([active.diagramId]);
});

test('permanent deletion rejects changed or untrashed targets and rolls back a failed batch', async ({ page }) => {
  await page.addInitScript(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args: Parameters<typeof remove>) {
      if (this.name === 'recovery' && args[0] === sessionStorage.getItem('fail-delete')) throw new DOMException('Test deletion failure', 'UnknownError');
      return remove.apply(this, args);
    };
  });
  await connect(page); const active = await sample();
  const first = await trashWithRecovery('First');
  const second = await trashWithRecovery('Second');
  const target = deletionTarget(first);
  await fails('delete_diagrams', { diagrams: [target, { diagramId: active.diagramId, expectedRevision: active.revision }] }, 'diagram_not_trashed');
  await fails('delete_diagrams', { diagrams: [target, target] }, 'invalid_arguments');
  await fails('delete_diagrams', { diagrams: [target, { diagramId: 'missing-diagram', expectedRevision: 0 }] }, 'diagram_not_found');
  const renamed = await call('manage_diagram', { ...deletionTarget(second), action: 'rename', name: 'Changed' });
  await fails('delete_diagrams', { diagrams: [target, deletionTarget(second)] }, 'revision_conflict');
  const restored = await call('manage_diagram', { ...deletionTarget(renamed), action: 'restore' });
  await fails('delete_diagrams', { diagrams: [target, deletionTarget(restored)] }, 'diagram_not_trashed');
  const trashed = await call('manage_diagram', { ...deletionTarget(restored), action: 'trash' });
  const beforeFirst = await stored(page, first.id);
  const beforeSecond = await stored(page, second.id);
  await page.evaluate(id => sessionStorage.setItem('fail-delete', id), second.id);
  const diagrams = [target, deletionTarget(trashed)];
  await fails('delete_diagrams', { diagrams }, 'storage_error');
  expect(await stored(page, first.id)).toEqual(beforeFirst);
  expect(await stored(page, second.id)).toEqual(beforeSecond);
  await page.evaluate(() => sessionStorage.removeItem('fail-delete'));
  expect(await call('delete_diagrams', { diagrams })).toEqual({ deletedIds: [first.id, second.id], count: 2 });
  for (const item of [first, second]) expect(await stored(page, item.id)).toEqual(removedRecords);
  await fails('delete_diagrams', { diagrams }, 'diagram_not_found');
  expect((await call('get_diagram')).elements).toEqual(active.elements);
});

test('storage estimates include images, recovery and trash without opening diagrams', async ({ page }, info) => {
  await connect(page);
  const active = await sample();
  const scene = JSON.parse((await exported('export_diagram', { diagramId: active.diagramId })).data);
  const dataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  scene.files.pixel = { id: 'pixel', mimeType: 'image/png', dataURL, created: 1 };
  scene.elements.push({ ...scene.elements.find((e: any) => e.id === 'box'), id: 'image', type: 'image', x: 450, y: 430, width: 50, height: 50, boundElements: [], fileId: 'pixel', status: 'saved', scale: [1, 1], crop: null, customData: { note: '🌿'.repeat(20_000) } });
  const imported = await call('import_diagram', { data: JSON.stringify(scene), name: 'Image diagram 🌿' });
  const initial = await stored(page, imported.id);
  expect(initial.meta.storageSize).toEqual(measuredSize(initial));
  expect(initial.meta.storageSize.sceneBytes).toBeGreaterThan(80_000);
  expect(initial.meta.storageSize.recoveryBytes).toBe(0);
  const copy = await call('manage_diagram', { diagramId: imported.id, expectedRevision: imported.revision, action: 'duplicate', name: 'Image copy' });
  const copied = await stored(page, copy.id);
  expect(copied.meta.storageSize).toEqual(measuredSize(copied));
  expect(copied.meta.storageSize.sceneBytes).toBe(initial.meta.storageSize.sceneBytes);

  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Your diagrams' });
  const row = panel.locator('li').filter({ has: page.getByText('Image diagram 🌿', { exact: true }) });
  await expect(row.locator('.diagram-size')).toHaveText(`~${formatStorageSize(estimatedStorageBytes(initial.meta.storageSize))}`);
  expect((await call('get_diagram')).diagramId).toBe(active.diagramId);

  const replaced = await call('import_diagram', { data: empty, replaceDiagramId: imported.id, expectedRevision: imported.revision });
  const replacement = await stored(page, imported.id);
  expect(replacement.meta.storageSize).toEqual(measuredSize(replacement));
  expect(replacement.meta.storageSize.recoveryBytes).toBe(initial.meta.storageSize.sceneBytes);
  const recovered = await call('manage_diagram', { diagramId: imported.id, expectedRevision: replaced.revision, action: 'recover' });
  const recovery = await stored(page, imported.id);
  expect(recovery.meta.storageSize).toEqual(measuredSize(recovery));
  expect(recovery.meta.storageSize.sceneBytes).toBe(initial.meta.storageSize.sceneBytes);
  expect(recovery.meta.storageSize.recoveryBytes).toBe(initial.meta.storageSize.sceneBytes);
  await call('manage_diagram', { diagramId: imported.id, expectedRevision: recovered.revision, action: 'trash' });
  const trashed = await stored(page, imported.id);
  expect(trashed.meta.storageSize).toEqual(measuredSize(trashed));
  await expect(row).toHaveCount(0);
  const all = (await call('list_diagrams', { includeTrash: true })).diagrams;
  const total = all.reduce((sum: number, item: any) => sum + estimatedStorageBytes(item.storageSize), 0);
  await expect(panel.getByTestId('library-storage-total')).toHaveText(`~${formatStorageSize(total)}`);
  await panel.getByLabel('Search diagrams').fill('Image copy');
  await expect(panel.locator('.diagram-list li')).toHaveCount(1);
  await expect(panel.getByTestId('library-storage-total')).toHaveText(`~${formatStorageSize(total)}`);
  await panel.getByLabel('Search diagrams').fill('');
  await panel.locator('.library-tabs').getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(row.locator('.diagram-size')).toHaveText(`~${formatStorageSize(estimatedStorageBytes(trashed.meta.storageSize))}`);
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await stored(page, imported.id)).meta.storageSize.recoveryBytes).toBe(initial.meta.storageSize.sceneBytes);

  await page.reload(); await connect(page, false);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const saved = await stored(page, imported.id);
  expect(saved.meta.storageSize).toEqual(measuredSize(saved));
  await expect(row.locator('.diagram-size')).toHaveText(`~${formatStorageSize(estimatedStorageBytes(saved.meta.storageSize))}`);
  expect((await call('get_diagram')).diagramId).toBe(active.diagramId);
  await page.screenshot({ path: info.outputPath('storage-sidebar.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.locator('.diagram-size')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('storage-sidebar-mobile.png') });
});

test('storage estimates cover older diagrams without rewriting or opening them', async ({ page }) => {
  await connect(page);
  const active = await sample();
  const copy = await call('manage_diagram', { diagramId: active.diagramId, expectedRevision: active.revision, action: 'duplicate', name: 'Older diagram' });
  await call('import_diagram', { data: empty, replaceDiagramId: copy.id, expectedRevision: copy.revision });
  const before = await stored(page, copy.id);
  delete before.meta.storageSize;
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('diagrams'); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('diagrams', 'readwrite');
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const r = tx.objectStore('diagrams').get(id);
    r.onsuccess = () => { const meta = r.result; delete meta.storageSize; tx.objectStore('diagrams').put(meta, id); };
    await done; db.close();
  }, copy.id);
  await page.reload(); await connect(page, false);
  const listed = (await call('list_diagrams')).diagrams.find((item: any) => item.id === copy.id);
  expect(listed.storageSize).toEqual(measuredSize(before));
  expect(await stored(page, copy.id)).toEqual(before);
  expect((await call('get_diagram')).diagramId).toBe(active.diagramId);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const row = page.locator('.diagram-list li').filter({ has: page.getByText('Older diagram', { exact: true }) });
  await expect(row.locator('.diagram-size')).toHaveText(`~${formatStorageSize(estimatedStorageBytes(listed.storageSize))}`);
  await call('manage_diagram', { diagramId: copy.id, expectedRevision: listed.revision, action: 'rename', name: 'Renamed older diagram 🌿' });
  const saved = await stored(page, copy.id);
  expect(saved.meta.storageSize).toEqual(measuredSize(saved));
  expect(saved.meta.storageSize.recoveryBytes).toBe(listed.storageSize.recoveryBytes);
});

test('autosave survives reload, preserves bindings and rejects old revisions', async ({ page }) => {
  await connect(page);
  const initial = await call('get_diagram');
  const created = await sample();
  await call('manage_diagram', { diagramId: created.diagramId, expectedRevision: created.revision, action: 'rename', name: 'Connection map' });
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  await call('list_diagrams');
  const before = await call('get_diagram');
  const disk = await stored(page, before.diagramId);
  expect(disk.scene.elements).toHaveLength(5);
  expect(disk.meta.name).toBe('Connection map');
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await page.reload(); await connect(page, false);
  const after = await call('get_diagram');
  expect(after.diagramId).toBe(before.diagramId);
  expect(after.revision).toBeGreaterThanOrEqual(before.revision);
  expect(after.elements).toEqual(before.elements);
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveValue('Connection map');
  await fails('apply_operations', { diagramId: initial.diagramId, expectedRevision: initial.revision, operations: [{ op: 'move', id: 'box', x: 10, y: 20 }] }, 'revision_conflict');
  await page.getByTestId('editor').click({ position: { x: 270, y: 250 } });
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await call('get_diagram')).elements.length).toBe(2);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  await call('list_diagrams');
  const deleted = await call('get_diagram');
  expect(deleted.elements.find((e: any) => e.id === 'arrow').fromId).toBeNull();
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await page.reload(); await connect(page, false);
  expect((await call('get_diagram')).elements).toEqual(deleted.elements);

});

test('loaded scenes clear the loader and autosave mouse edits after reload and switching', async ({ page }) => {
  await connect(page);
  const first = await sample();
  await call('list_diagrams');
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await page.reload(); await connect(page, false);

  async function drawAndCheckSave(id: string, expectedElementCount: number) {
    const editor = page.getByTestId('editor');
    const bounds = await editor.boundingBox();
    if (!bounds) throw new Error('Canvas missing');
    await editor.click({ position: { x: 500, y: 550 } });
    await page.keyboard.press('r');
    await page.mouse.move(bounds.x + 480, bounds.y + 500);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 600, bounds.y + 590, { steps: 5 });
    await page.mouse.up();
    // Read IndexedDB directly: get_diagram observes changes itself and could
    // hide a broken native onChange subscription while the loader is stuck.
    await expect.poll(async () => (await stored(page, id)).scene.elements.length).toBe(expectedElementCount);
    await expect(editor.getByText(/Loading scene/)).toBeHidden();
    await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  }

  await drawAndCheckSave(first.diagramId, 6);
  const second = await call('create_diagram', { name: 'Another scene' });
  await open(second.id);
  await drawAndCheckSave(second.id, 1);
  await open(first.diagramId);
  await expect(page.getByTestId('editor').getByText(/Loading scene/)).toBeHidden();
  expect((await call('get_diagram')).elements).toHaveLength(4);
});

test('library creation, duplication, switching, trash and restore work in UI and MCP', async ({ page }, info) => {
  await connect(page); const first = await sample();
  const copy = await call('manage_diagram', { diagramId: first.diagramId, expectedRevision: first.revision, action: 'duplicate', name: 'Copy' });
  expect(copy.id).not.toBe(first.diagramId);
  expect((await call('get_diagram')).diagramId).toBe(first.diagramId);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  await page.getByRole('button', { name: 'New diagram' }).click();
  await expect.poll(async () => (await call('get_diagram')).diagramId).not.toBe(first.diagramId);
  const second = await call('get_diagram');
  await page.getByLabel('Diagram name', { exact: true }).fill('Another diagram');
  await page.getByLabel('Diagram name', { exact: true }).press('Enter');
  await expect.poll(async () => (await call('get_diagram')).name).toBe('Another diagram');
  await open(copy.id);
  expect((await call('get_diagram')).elements).toEqual(first.elements);
  await page.getByRole('button', { name: 'Close diagrams', exact: true }).click();
  await page.getByTestId('editor').click({ position: { x: 900, y: 600 } });
  await page.keyboard.press('ControlOrMeta+z');
  expect((await call('get_diagram')).elements).toEqual(first.elements);
  await fails('open_diagram', { diagramId: second.diagramId, expectedActiveDiagramId: first.diagramId, expectedActiveRevision: first.revision }, 'diagram_changed');
  const current = await call('get_diagram');
  await call('manage_diagram', { diagramId: copy.id, expectedRevision: current.revision, action: 'trash' });
  expect((await call('get_diagram')).diagramId).not.toBe(copy.id);
  expect((await call('list_diagrams')).diagrams.map((d: any) => d.id)).not.toContain(copy.id);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).first().click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  expect((await call('list_diagrams')).diagrams.map((d: any) => d.id)).toContain(copy.id);
  await page.getByRole('complementary', { name: 'Your diagrams' }).getByRole('button', { name: 'Diagrams', exact: true }).click();
  await page.screenshot({ path: info.outputPath('library.png') });
});

test('editable, SVG and PNG exports are retrievable; imports preserve images, labels and viewport', async ({ page }) => {
  await connect(page); const original = await sample();
  const file = await exported('export_diagram', { diagramId: original.diagramId });
  const scene = JSON.parse(file.data);
  expect(scene.type).toBe('excalidraw');
  expect(scene.elements.find((e: any) => e.id === 'arrow').startBinding.elementId).toBe('box');
  // A native image plus sizable metadata forces multiple transfer chunks.
  const dataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  scene.files.pixel = { id: 'pixel', mimeType: 'image/png', dataURL, created: 1 };
  scene.elements.push({ ...scene.elements.find((e: any) => e.id === 'box'), id: 'image', type: 'image', x: 450, y: 430, width: 50, height: 50, boundElements: [], fileId: 'pixel', status: 'saved', scale: [1, 1], crop: null, customData: { note: '🌿'.repeat(20_000) } });
  scene.appState = { ...scene.appState, scrollX: 50, scrollY: -30, zoom: { value: 0.8 } };
  const data = JSON.stringify(scene);
  const uploadId = await upload('diagram', data);
  const imported = await call('import_diagram', { uploadId, name: 'Portable' });
  await open(imported.id);
  const roundtrip = JSON.parse((await exported('export_diagram', { diagramId: imported.id })).data);
  expect(roundtrip.files.pixel.dataURL).toBe(dataURL);
  expect(roundtrip.elements.find((e: any) => e.id === 'image').customData.note).toBe('🌿'.repeat(20_000));
  expect(roundtrip.appState).toMatchObject({ scrollX: 50, scrollY: -30, zoom: { value: 0.8 } });
  for (const format of ['svg', 'png']) {
    const image = await exported('export_diagram', { diagramId: imported.id, format });
    expect(image.mimeType).toBe(`image/${format === 'svg' ? 'svg+xml' : 'png'}`);
    if (format === 'svg') { expect(image.data).toContain('<svg'); expect(image.data).toContain('</svg>'); }
    else expect(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
  await call('list_diagrams');
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await page.reload(); await connect(page, false);
  const persisted = JSON.parse((await exported('export_diagram', { diagramId: imported.id })).data);
  expect(persisted.files.pixel.dataURL).toBe(dataURL);
  expect(persisted.appState).toMatchObject({ scrollX: 50, scrollY: -30, zoom: { value: 0.8 } });
});

test('library backups import atomically with new IDs, including trash; invalid replacement leaves canvas intact', async ({ page }) => {
  await connect(page); const first = await sample();
  const unused = await call('create_diagram', { name: 'In trash' });
  await call('manage_diagram', { diagramId: unused.id, expectedRevision: unused.revision, action: 'trash' });
  const file = await exported('export_library');
  const library = JSON.parse(file.data);
  expect(library.diagrams).toHaveLength(2);
  const valid = JSON.stringify(library);
  library.diagrams[1].document.version = 99;
  await fails('import_library', { data: JSON.stringify(library) }, 'invalid_import');
  expect((await call('list_diagrams', { includeTrash: true })).diagrams).toHaveLength(2);
  const restored = await call('import_library', { uploadId: await upload('library', valid) });
  expect(restored.imported).toHaveLength(2);
  for (const item of restored.imported) expect(item.id).not.toBe(item.sourceId);
  expect(restored.imported.find((item: any) => item.sourceId === unused.id).deletedAt).toBeTruthy();
  expect((await call('list_diagrams', { includeTrash: true })).diagrams).toHaveLength(4);
  const current = await call('get_diagram');
  const native = JSON.parse((await exported('export_diagram', { diagramId: first.diagramId })).data);
  native.elements.find((e: any) => e.id === 'arrow').startBinding.elementId = 'missing';
  await fails('import_diagram', { data: JSON.stringify(native), replaceDiagramId: first.diagramId, expectedRevision: current.revision }, 'invalid_import');
  await fails('import_diagram', { data: empty, replaceDiagramId: first.diagramId, expectedRevision: current.revision - 1 }, 'revision_conflict');
  expect((await call('get_diagram')).elements).toEqual(current.elements);
  await call('import_diagram', { data: empty, replaceDiagramId: first.diagramId, expectedRevision: current.revision });
  const replaced = await call('get_diagram'); expect(replaced.elements).toHaveLength(0);
  await call('manage_diagram', { action: 'recover', diagramId: first.diagramId, expectedRevision: replaced.revision });
  expect((await call('get_diagram')).elements).toEqual(current.elements);
});

test('document menu exports and the diagrams panel imports and backs up portable content', async ({ page }) => {
  await connect(page); const first = await sample();
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export editable diagram', exact: true }).click();
  const download = await downloading;
  const path = await download.path();
  const data = await readFile(path!, 'utf8');
  expect(JSON.parse(data).elements).toHaveLength(5);
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  await (await choosing).setFiles({ name: 'Restored.excalidraw', mimeType: 'application/json', buffer: Buffer.from(data) });
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveValue('Restored');
  const imported = await call('get_diagram');
  expect(imported.diagramId).not.toBe(first.diagramId);
  expect(imported.elements).toEqual(first.elements);
  const backingUp = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up all diagrams', exact: true }).click();
  const backup = JSON.parse(await readFile((await (await backingUp).path())!, 'utf8'));
  expect(backup.type).toBe('diagrams-library');
  expect(backup.diagrams.map((item: any) => item.id)).toEqual(expect.arrayContaining([first.diagramId, imported.diagramId]));
});

test('document actions preserve clear confirmation and undo, with accessible desktop and mobile controls', async ({ page }, info) => {
  await connect(page); const first = await sample();
  const actions = page.getByRole('button', { name: 'Diagram actions', exact: true });
  await expect(page.getByTestId('main-menu-trigger')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
  const shapes = page.getByRole('checkbox', { name: 'Custom Shapes', exact: true });
  await page.getByTitle('Custom Shapes', { exact: true }).click();
  await expect(shapes).toBeChecked();
  await expect(page.locator('.default-sidebar')).toBeVisible();
  await page.getByTestId('sidebar-close').click();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Help', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await actions.focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(actions).toBeFocused();
  await actions.click(); await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeFocused();
  await page.getByLabel('Diagram name', { exact: true }).fill('Menu test');
  await page.getByLabel('Diagram name', { exact: true }).press('Enter');
  await expect.poll(async () => (await call('get_diagram')).name).toBe('Menu test');
  await actions.click(); await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveValue('Menu test copy');
  const copy = await call('get_diagram');
  expect(copy.diagramId).not.toBe(first.diagramId);

  const clear = page.getByTestId('clear-canvas-button');
  const confirm = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Clear canvas', exact: true }) });
  await actions.click(); await clear.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await call('get_diagram')).elements).toEqual(copy.elements);
  await actions.click(); await clear.click();
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(async () => (await call('get_diagram')).elements.length).toBe(0);
  await page.getByTestId('button-undo').click();
  await expect.poll(async () => (await call('get_diagram')).elements.length).toBe(copy.elements.length);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');

  await actions.click(); await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect.poll(async () => (await call('get_diagram')).diagramId).not.toBe(copy.diagramId);
  const collection = await call('list_diagrams', { includeTrash: true });
  expect(collection.diagrams.find((item: any) => item.id === copy.diagramId).deletedAt).toBeTruthy();
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).first().click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  expect((await call('list_diagrams')).diagrams.map((item: any) => item.id)).toContain(copy.diagramId);
  await page.getByRole('button', { name: 'Close diagrams', exact: true }).click();
  await actions.click();
  await page.screenshot({ path: info.outputPath('document-menu.png') });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTitle('Custom Shapes', { exact: true }).click();
  await expect(shapes).toBeChecked();
  await expect(page.locator('.default-sidebar')).toBeVisible();
  await page.getByTestId('sidebar-close').click();
  await actions.click();
  const bounds = await page.getByRole('group', { name: 'Diagram actions', exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Move to trash', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('mobile-menu.png') });
  await page.keyboard.press('Escape');
});

test('storage failure keeps the live canvas exportable and retries without corrupting the previous save', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'scenes' && sessionStorage.getItem('test-quota') === 'yes') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await connect(page); const created = await sample();
  const old = await trashWithRecovery('Free this space');
  await call('list_diagrams');
  const before = await stored(page, created.diagramId);
  await page.evaluate(() => sessionStorage.setItem('test-quota', 'yes'));
  const current = await call('get_diagram');
  const args = { diagramId: current.diagramId, expectedRevision: current.revision, requestId: 'quota-edit', operations: [{ op: 'move', id: 'box', x: 300, y: 420 }] };
  const edited = await call('apply_operations', args);
  expect(edited).toMatchObject({ saveStatus: 'error', replayed: false });
  expect(edited.saveError).toContain('storage is full');
  const retry = await call('apply_operations', args);
  expect(retry).toMatchObject({ saveStatus: 'error', replayed: true, appliedRevision: edited.appliedRevision });
  await expect(page.getByTestId('save-status')).toHaveText('Save failed');
  await expect(page.getByRole('alert')).toContainText('storage is full');
  expect(await stored(page, created.diagramId)).toEqual(before);
  const live = JSON.parse((await exported('export_diagram', { diagramId: created.diagramId })).data);
  expect(live.elements.find((e: any) => e.id === 'box').y).toBe(420);
  const listing = await call('list_diagrams', { includeTrash: true });
  expect(listing.saveStatus).toBe('error');
  expect(listing.diagrams.find((item: any) => item.id === old.id).deletedAt).toBeTruthy();
  await page.getByRole('banner').getByRole('button', { name: 'Diagrams', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Your diagrams' });
  await panel.locator('.library-tabs').getByRole('button', { name: 'Trash', exact: true }).click();
  await panel.getByRole('button', { name: 'Empty trash', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Empty trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page, old.id)).toEqual(removedRecords);
  expect(await stored(page, created.diagramId)).toEqual(before);
  expect((await call('get_diagram')).elements.find((e: any) => e.id === 'box').y).toBe(420);
  await page.evaluate(() => sessionStorage.removeItem('test-quota'));
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  expect((await stored(page, created.diagramId)).scene.elements.find((e: any) => e.id === 'box').y).toBe(420);
  await page.reload(); await connect(page, false);
  expect(await call('apply_operations', args)).toMatchObject({ replayed: true, saveStatus: 'saved', appliedRevision: edited.appliedRevision });
});

test('a second tab cannot overwrite the same browser library and can retry after the first closes', async ({ page, context }) => {
  await connect(page); const created = await sample(); await call('list_diagrams');
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('alert')).toContainText('already open in another tab');
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await page.close();
  await second.getByRole('button', { name: 'Retry', exact: true }).click();
  await connect(second, false);
  expect((await call('get_diagram')).diagramId).toBe(created.diagramId);
  expect((await call('get_diagram')).elements).toEqual(created.elements);
  await second.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await second.close();
});

test('transfer offsets, limits, release and malformed files fail without changing the library', async ({ page }) => {
  await connect(page); const original = await sample();
  const { uploadId } = await call('begin_import', { kind: 'diagram' });
  await fails('write_import_chunk', { uploadId, offset: 5, data: empty }, 'invalid_transfer');
  await call('write_import_chunk', { uploadId, offset: 0, data: empty });
  await fails('write_import_chunk', { uploadId, offset: 0, data: empty }, 'invalid_transfer');
  await fails('import_library', { uploadId }, 'invalid_transfer');
  await call('release_transfer', { transferId: uploadId });
  await fails('import_diagram', { uploadId }, 'transfer_expired');
  await fails('import_diagram', { data: 'broken' }, 'invalid_import');
  await fails('import_diagram', { data: JSON.stringify({ type: 'excalidraw', version: 99, elements: [] }) }, 'invalid_import');
  expect((await call('list_diagrams')).diagrams).toHaveLength(1);
  expect((await call('get_diagram')).elements).toEqual(original.elements);
});
