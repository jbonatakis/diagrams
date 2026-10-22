import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = 'phase-one-browser-test-token-not-a-secret';
let client: Client;
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  client = new Client({ name: 'phase-two-browser-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4180/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
test.afterEach(async ({ page }) => {
  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  if (await disconnect.isVisible().catch(() => false)) await disconnect.click();
  await client.close();
  expect(errors).toEqual([]);
});
async function connect(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.getByLabel('Connection token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect this canvas' }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
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
    const tx = db.transaction(['diagrams', 'scenes']);
    const get = (store: string) => new Promise<any>((resolve) => { const r = tx.objectStore(store).get(key); r.onsuccess = () => resolve(r.result); });
    const [meta, scene] = await Promise.all([get('diagrams'), get('scenes')]); db.close();
    return { meta, scene };
  }, id);
}

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
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
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
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.reload(); await connect(page, false);
  expect((await call('get_diagram')).elements).toEqual(deleted.elements);

});

test('loaded scenes clear the loader and autosave mouse edits after reload and switching', async ({ page }) => {
  await connect(page);
  const first = await sample();
  await call('list_diagrams');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
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
  await page.getByRole('button', { name: 'Diagram library', exact: true }).click();
  await page.getByRole('button', { name: 'New diagram' }).click();
  await expect.poll(async () => (await call('get_diagram')).diagramId).not.toBe(first.diagramId);
  const second = await call('get_diagram');
  await page.getByLabel('Diagram name', { exact: true }).fill('Another diagram');
  await page.getByLabel('Diagram name', { exact: true }).press('Enter');
  await expect.poll(async () => (await call('get_diagram')).name).toBe('Another diagram');
  await open(copy.id);
  expect((await call('get_diagram')).elements).toEqual(first.elements);
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await page.getByTestId('editor').click({ position: { x: 900, y: 600 } });
  await page.keyboard.press('ControlOrMeta+z');
  expect((await call('get_diagram')).elements).toEqual(first.elements);
  await fails('open_diagram', { diagramId: second.diagramId, expectedActiveDiagramId: first.diagramId, expectedActiveRevision: first.revision }, 'diagram_changed');
  const current = await call('get_diagram');
  await call('manage_diagram', { diagramId: copy.id, expectedRevision: current.revision, action: 'trash' });
  expect((await call('get_diagram')).diagramId).not.toBe(copy.id);
  expect((await call('list_diagrams')).diagrams.map((d: any) => d.id)).not.toContain(copy.id);
  await page.getByRole('button', { name: 'Diagram library', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).first().click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  expect((await call('list_diagrams')).diagrams.map((d: any) => d.id)).toContain(copy.id);
  await page.getByRole('button', { name: 'Diagrams', exact: true }).click();
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
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
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

test('file menu downloads portable content and imports it as a separate diagram', async ({ page }) => {
  await connect(page); const first = await sample();
  await page.getByRole('button', { name: 'Files', exact: false }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export editable diagram', exact: true }).click();
  const download = await downloading;
  const path = await download.path();
  const data = await readFile(path!, 'utf8');
  expect(JSON.parse(data).elements).toHaveLength(5);
  await page.getByLabel('Import file', { exact: true }).setInputFiles({ name: 'Restored.excalidraw', mimeType: 'application/json', buffer: Buffer.from(data) });
  await expect(page.getByLabel('Diagram name', { exact: true })).toHaveValue('Restored');
  const imported = await call('get_diagram');
  expect(imported.diagramId).not.toBe(first.diagramId);
  expect(imported.elements).toEqual(first.elements);
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
  await call('list_diagrams');
  const before = await stored(page, created.diagramId);
  await page.evaluate(() => sessionStorage.setItem('test-quota', 'yes'));
  const current = await call('get_diagram');
  await call('apply_operations', { diagramId: current.diagramId, expectedRevision: current.revision, operations: [{ op: 'move', id: 'box', x: 300, y: 420 }] });
  await expect(page.getByTestId('save-status')).toHaveText('Save failed');
  await expect(page.getByRole('alert')).toContainText('storage is full');
  expect(await stored(page, created.diagramId)).toEqual(before);
  const live = JSON.parse((await exported('export_diagram', { diagramId: created.diagramId })).data);
  expect(live.elements.find((e: any) => e.id === 'box').y).toBe(420);
  await page.evaluate(() => sessionStorage.removeItem('test-quota'));
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  expect((await stored(page, created.diagramId)).scene.elements.find((e: any) => e.id === 'box').y).toBe(420);
});

test('a second tab cannot overwrite the same browser library and can retry after the first closes', async ({ page, context }) => {
  await connect(page); const created = await sample(); await call('list_diagrams');
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByRole('alert')).toContainText('already open in another tab');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.close();
  await second.getByRole('button', { name: 'Retry', exact: true }).click();
  await connect(second, false);
  expect((await call('get_diagram')).diagramId).toBe(created.diagramId);
  expect((await call('get_diagram')).elements).toEqual(created.elements);
  await second.getByRole('button', { name: 'Disconnect', exact: true }).click();
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
