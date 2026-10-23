import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent, readyCanvas } from './connection-helpers';
import { formatStorageSize } from '../src/library/size';

test.setTimeout(60_000);
const sourceURL = 'https://libraries.excalidraw.com/libraries/test/custom-shapes.excalidrawlib';
const callback = (url = sourceURL) => '/?install=custom-shapes#addLibrary=' + encodeURIComponent(url);
const review = (page: Page) => page.getByRole('region', { name: 'Install custom shapes' });
const rectangle = (id: string) => ({ id, type: 'rectangle', x: 20, y: 30, width: 120, height: 80, angle: 0,
  version: 1, versionNonce: 1, seed: 1, isDeleted: false, groupIds: [], boundElements: null,
  strokeColor: '#123456', backgroundColor: '#abcdef', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 0, opacity: 100, roundness: null, frameId: null, link: null, locked: false });
const simpleFile = () => ({ type: 'excalidrawlib', version: 2, libraryItems: [
  { id: 'plain-box', status: 'unpublished', created: 1, elements: [rectangle('box')] },
] });
let client: Client;
let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addInitScript(() => {
    delete (window as any).showOpenFilePicker;
    delete (window as any).showSaveFilePicker;
  });
});
test.afterEach(async () => { await client?.close(); expect(errors).toEqual([]); });

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent;
}
async function apply(operations: Record<string, unknown>[]) {
  const state = await call('get_diagram');
  return call('apply_operations', { diagramId: state.diagramId, expectedRevision: state.revision, operations });
}
async function rawScene() {
  const state = await call('get_diagram');
  const file = await call('export_diagram', { diagramId: state.diagramId });
  let data = file.data, offset = file.nextOffset;
  while (offset !== null) {
    const chunk = await call('read_export', { artifactId: file.artifactId, offset });
    data += chunk.data; offset = chunk.nextOffset;
  }
  await call('release_transfer', { transferId: file.artifactId });
  return JSON.parse(data);
}
async function mockLibrary(page: Page, file: unknown) {
  await page.context().route(sourceURL, route => route.fulfill({ contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(file) }));
}
async function handoff(page: Page) {
  const returned = await page.context().newPage();
  await returned.goto(callback());
  await expect(returned.getByRole('heading', { name: 'Ready in your Diagrams tab' })).toBeVisible();
  await returned.close();
  await page.bringToFront();
  await expect(review(page).getByRole('button', { name: 'Add shapes', exact: true })).toBeEnabled();
}
async function install(page: Page) {
  await handoff(page);
  await review(page).getByRole('button', { name: 'Add shapes', exact: true }).click();
  await expect(review(page)).toBeHidden();
}
async function shapesMenu(page: Page) {
  const toggle = page.getByRole('checkbox', { name: 'Custom Shapes', exact: true });
  if (!await toggle.isChecked()) await page.getByTitle('Custom Shapes', { exact: true }).click();
  await page.locator('.library-menu-dropdown-container').getByTestId('dropdown-menu-button').click();
}
async function diskShapes(page: Page): Promise<any[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('diagrams', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, request = db.transaction('settings').objectStore('settings').get('customShapes');
      request.onsuccess = () => { db.close(); resolve(request.result ?? []); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
}

for (const mobile of [false, true]) test(`custom shape storage tracks selections, export and confirmed removal (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  const baseline = await apply([{ op: 'create_shape', id: 'canvas-box', shape: 'rectangle', x: 120, y: 180, width: 100, height: 80 }]);
  await page.getByTestId('editor').click({ position: { x: 170, y: 220 } });
  await expect.poll(async () => (await call('get_diagram')).selectedElementIds).toContain('canvas-box');
  // Deliberately mix published/personal ordering and use multibyte text. The
  // library also shows an unsaved canvas-selection tile, which must not count.
  const file = { type: 'excalidrawlib', version: 2, libraryItems: [
    { id: 'public', status: 'published', created: 1, elements: [{ ...rectangle('public-box'), customData: { note: 'Cloud ☁️ '.repeat(400) } }] },
    ...simpleFile().libraryItems,
    { id: 'personal', status: 'unpublished', created: 1, elements: [{ ...rectangle('personal-box'), customData: { note: 'Private'.repeat(50) } }] },
  ] };
  await mockLibrary(page, file); await install(page);
  const saved = await diskShapes(page);
  const bytes = (id: string) => Buffer.byteLength(JSON.stringify(saved.find(item => item.id === id)), 'utf8');
  const total = bytes('public') + bytes('plain-box') + bytes('personal');
  const footer = page.getByRole('region', { name: 'Custom shape storage', exact: true });
  await expect(footer).toBeInViewport();
  await expect(footer.getByTestId('custom-shapes-storage-total')).toHaveText('~' + formatStorageSize(total));
  await expect(footer).toContainText('3 shapes');
  await expect(page.locator('.library-unit__adder')).toBeVisible();
  const units = page.locator('.library-menu-items-container__grid > .library-unit').filter({ hasNot: page.locator('.library-unit__adder') });
  await expect(units).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(page.getByText('Personal Library', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Excalidraw Library', { exact: true })).toBeHidden();
  // Both native categories now fill the same row, including the pending tile.
  await expect.poll(() => units.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top))).size)).toBe(1);
  await units.nth(0).hover(); await units.nth(0).getByRole('checkbox').click();
  await expect(footer).toContainText('1 selected');
  await expect(footer.getByTestId('custom-shapes-storage-selected')).toHaveText('~' + formatStorageSize(bytes('plain-box')));
  await units.nth(2).locator('.library-unit__dragger').click({ modifiers: ['Shift'] });
  await expect(footer).toContainText('3 selected');
  await expect(footer.getByTestId('custom-shapes-storage-selected')).toHaveText('~' + formatStorageSize(total));
  await units.nth(1).getByRole('checkbox').click();
  const selected = bytes('plain-box') + bytes('public');
  await expect(footer).toContainText('2 selected');
  await expect(footer.getByTestId('custom-shapes-storage-selected')).toHaveText('~' + formatStorageSize(selected));
  await expect(page.getByText(/Frees ~/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('custom-shapes-storage.png') });
  // Selecting templates for export must never imply that space will be freed.
  await shapesMenu(page);
  const downloading = page.waitForEvent('download');
  await page.getByTestId('lib-dropdown--export').click();
  const exported = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(exported.libraryItems).toHaveLength(2);
  expect(await diskShapes(page)).toEqual(saved);
  await expect(page.getByText(/Frees ~/)).toHaveCount(0);
  await shapesMenu(page);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation.getByTestId('custom-shapes-removal-size')).toHaveText(`Frees ~${formatStorageSize(selected)} in this browser.`);
  await page.screenshot({ path: testInfo.outputPath('custom-shapes-removal.png') });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await diskShapes(page)).toEqual(saved);
  await shapesMenu(page);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(async () => (await diskShapes(page)).map(item => item.id)).toEqual(['personal']);
  await expect(footer.getByTestId('custom-shapes-storage-total')).toHaveText('~' + formatStorageSize(bytes('personal')));
  await expect(footer.getByTestId('custom-shapes-storage-selected')).toHaveCount(0);
  expect((await call('get_diagram')).elements).toEqual(baseline.elements);
  await page.reload(); await readyCanvas(page, false);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  await shapesMenu(page);
  const browse = page.locator('.library-menu-browse-button');
  const browseBottom = await browse.evaluate(element => element.getBoundingClientRect().bottom);
  const menuTop = await page.locator('.library-menu-dropdown-container').evaluate(element => element.getBoundingClientRect().top);
  await page.getByRole('button', { name: 'Reset library', exact: true }).click();
  await expect(confirmation.getByTestId('custom-shapes-removal-size')).toHaveText(`Frees ~${formatStorageSize(bytes('personal'))} in this browser.`);
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(footer.getByTestId('custom-shapes-storage-total')).toHaveText('~0 B');
  await expect(footer).toContainText('0 shapes');
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(browse).toBeInViewport();
  await expect.poll(() => browse.evaluate((element, bottom) => Math.abs(element.getBoundingClientRect().bottom - bottom), browseBottom)).toBeLessThan(2);
  await expect.poll(() => page.locator('.library-menu-dropdown-container').evaluate((element, top) => Math.abs(element.getBoundingClientRect().top - top), menuTop)).toBeLessThan(2);
  await shapesMenu(page);
  await expect(page.getByTestId('lib-dropdown--load')).toBeVisible();
});

test('catalog handoff preserves the open canvas and installs persist across reload and diagram switches', async ({ page }) => {
  client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  const original = await apply([{ op: 'create_text', id: 'keep', x: 100, y: 150, text: 'Keep my canvas' }]);
  const library = simpleFile();
  await mockLibrary(page, { ...library, libraryItems: library.libraryItems.map(item => ({ ...item, name: 'Cloud Server' })) });
  await handoff(page);
  expect((await call('list_custom_shapes')).total).toBe(0); // Human confirmation is still required.
  await review(page).getByRole('button', { name: 'Add shapes', exact: true }).click();
  await expect(review(page)).toBeHidden();
  expect(await call('get_diagram')).toMatchObject({ diagramId: original.diagramId, elements: original.elements });
  expect(await call('list_custom_shapes')).toMatchObject({ total: 1, saveStatus: 'saved', shapes: [{ id: 'plain-box', name: 'Cloud Server', text: '', types: ['rectangle'], width: 120, height: 80 }] });
  const browse = new URL(await page.locator('.library-menu-browse-button').getAttribute('href') as string);
  expect(new URL(browse.searchParams.get('referrer')!).searchParams.get('install')).toBe('custom-shapes');
  await install(page);
  expect((await call('list_custom_shapes')).total).toBe(1); // Reinstallation merges, without duplicates.
  const created = await call('create_diagram', { name: 'Another diagram' });
  await call('open_diagram', { diagramId: created.id, expectedActiveDiagramId: original.diagramId, expectedActiveRevision: original.revision });
  expect((await call('list_custom_shapes')).total).toBe(1);
  await page.reload(); await readyCanvas(page, false);
  expect(await call('list_custom_shapes', { query: 'cloud server' })).toMatchObject({ total: 1, shapes: [{ name: 'Cloud Server' }] });
  expect(await call('list_custom_shapes', { query: 'rectangle', limit: 1 })).toMatchObject({ total: 1, nextOffset: null });
  expect(await call('list_custom_shapes', { query: 'missing' })).toMatchObject({ total: 0 });
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  await page.getByTitle('Custom Shapes', { exact: true }).click();
  await expect(page.locator('.library-menu-items-container .library-unit__active')).toHaveCount(1);
});

test('agents preview named and unnamed templates before insertion without changing canvas, storage or undo', async ({ page }, testInfo) => {
  client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  const file = simpleFile();
  await mockLibrary(page, { ...file, libraryItems: [
    { ...file.libraryItems[0], name: 'Cloud Server' },
    { id: 'unlabeled', status: 'published', created: 1, elements: [{ ...rectangle('round'), type: 'ellipse', backgroundColor: '#ffbb99' }] },
    { id: 'third', status: 'published', created: 1, elements: [{ ...rectangle('diamond'), type: 'diamond', backgroundColor: '#99ccff' }] },
  ] });
  await install(page);
  await page.getByTestId('sidebar-close').click();
  await page.getByTestId('editor').click({ position: { x: 950, y: 700 } });
  const initial = await apply([{ op: 'create_shape', id: 'keep', shape: 'rectangle', x: 50, y: 50, fill: '#abcdef' }]);
  const changed = await apply([{ op: 'update', id: 'keep', changes: { fill: '#ffddaa' } }]);
  const before = await call('get_diagram'), saved = await diskShapes(page), scene = await rawScene();
  async function preview(args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name: 'preview_custom_shapes', arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const image = (result.content as { type: string; data: string; mimeType: string }[]).find(block => block.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    const bytes = Buffer.from(image.data, 'base64');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const metadata = result.structuredContent as any;
    expect(metadata).not.toHaveProperty('data');
    expect(metadata.width).toBe(bytes.readUInt32BE(16)); expect(metadata.height).toBe(bytes.readUInt32BE(20));
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(Number(args.maxSize ?? 1200));
    return { metadata, image, bytes };
  }
  const gallery = await preview({ limit: 2, maxSize: 512 });
  expect(gallery.metadata).toMatchObject({ total: 3, nextOffset: 2, shapes: [
    { number: 1, id: 'plain-box', name: 'Cloud Server', text: '' }, { number: 2, id: 'unlabeled', text: '' },
  ] });
  await testInfo.attach('custom-shape-gallery', { body: gallery.bytes, contentType: 'image/png' });
  // Verify there are actual colored drawings, not just borders/numbers in a valid PNG.
  const colored = await page.evaluate(async data => {
    const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 40) count++;
    return count;
  }, gallery.image.data);
  expect(colored).toBeGreaterThan(100);
  expect((await preview({ offset: gallery.metadata.nextOffset, limit: 2 })).metadata).toMatchObject({ nextOffset: null, shapes: [{ number: 1, id: 'third' }] });
  expect((await preview({ query: 'CLOUD SERVER' })).metadata.shapes).toMatchObject([{ number: 1, id: 'plain-box' }]);
  expect((await preview({ shapeIds: ['third', 'plain-box'] })).metadata.shapes).toMatchObject([{ number: 1, id: 'third' }, { number: 2, id: 'plain-box' }]);
  expect((await preview({ shapeIds: ['unlabeled'], maxSize: 768 })).metadata).toMatchObject({ width: 768, height: 768, shapes: [{ number: 1, id: 'unlabeled' }] });
  for (const args of [{ shapeIds: ['plain-box', 'missing'] }, { query: 'does-not-exist' }, { offset: 99 }]) {
    expect((await client.callTool({ name: 'preview_custom_shapes', arguments: args })).isError).toBe(true);
  }
  expect(await call('get_diagram')).toEqual(before);
  expect(await diskShapes(page)).toEqual(saved);
  expect(await rawScene()).toEqual(scene);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await call('get_diagram')).elements).toEqual(initial.elements);
  expect(changed.elements).not.toEqual(initial.elements);
});

test('agents insert independent templates with bindings, atomic failure, retry protection and native undo', async ({ page }) => {
  client = await connectAgent(page);
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['list_custom_shapes', 'insert_custom_shape']));
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  const baseline = await apply([
    { op: 'create_shape', id: 'a', shape: 'rectangle', x: 160, y: 180, width: 180, height: 100, label: 'Browser' },
    { op: 'create_shape', id: 'b', shape: 'ellipse', x: 500, y: 180, width: 180, height: 100, label: 'Storage' },
    { op: 'connect', id: 'link', fromId: 'a', toId: 'b', label: 'Saves', strokeStyle: 'dashed' },
  ]);
  const file = simpleFile();
  file.libraryItems.push({ id: 'browser-flow', status: 'published', created: 1, elements: (await rawScene()).elements });
  await mockLibrary(page, file); await install(page);
  const discovered = await call('list_custom_shapes', { query: 'Browser' });
  expect(discovered).toMatchObject({ total: 1, shapes: [{ id: 'browser-flow', text: expect.stringContaining('Browser') }] });
  const firstPage = await call('list_custom_shapes', { limit: 1 });
  expect(firstPage.nextOffset).toBe(1);
  expect((await call('list_custom_shapes', { offset: 1, limit: 1 })).shapes[0].id).not.toBe(firstPage.shapes[0].id);
  const saved = await diskShapes(page);
  const target = { diagramId: baseline.diagramId, expectedRevision: baseline.revision, requestId: crypto.randomUUID() };
  const shape = { shapeId: discovered.shapes[0].id, idPrefix: 'copy', x: 160, y: 430 };
  for (const operation of [
    { op: 'create_shape', id: 'star', shape: 'star', x: 0, y: 0 },
    { op: 'create_shape', id: 'star', shape: { type: 'star' }, x: 0, y: 0 },
    { type: 'create_element', id: 'star', x: 0, y: 0 },
  ]) {
    const failed = await client.callTool({ name: 'apply_operations', arguments: { ...target, operations: [operation] } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('list_custom_shapes');
    expect(JSON.stringify(failed.content)).toContain('insert_custom_shape');
  }
  const missing = await client.callTool({ name: 'insert_custom_shape', arguments: { ...target, ...shape, shapeId: 'not-installed' } });
  expect(missing.isError).toBe(true);
  expect((await call('get_diagram')).elements).toEqual(baseline.elements);
  const inserted = await call('insert_custom_shape', { ...target, ...shape });
  const id = (source: string) => inserted.copies.find((item: any) => item.sourceId === source).id;
  const element = (source: string) => inserted.elements.find((item: any) => item.id === id(source));
  expect(element('a')).toMatchObject({ x: 160, y: 430, text: 'Browser' });
  expect(element('link')).toMatchObject({ fromId: id('a'), toId: id('b'), text: 'Saves', strokeStyle: 'dashed' });
  expect(element('a').groupIds.length).toBeGreaterThan(0);
  expect(element('a').groupIds).toEqual(element('b').groupIds);
  expect(await call('insert_custom_shape', { ...target, ...shape })).toMatchObject({ replayed: true, copies: inserted.copies, elements: inserted.elements });
  expect(await call('apply_operations', { ...target, operations: [{ op: 'insert_custom_shape', ...shape }] })).toMatchObject({ replayed: true, copies: inserted.copies, elements: inserted.elements });
  const stale = await client.callTool({ name: 'insert_custom_shape', arguments: { ...target, ...shape, requestId: crypto.randomUUID(), idPrefix: 'stale' } });
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale.content)).toContain('revision_conflict');
  const failed = await client.callTool({ name: 'apply_operations', arguments: { diagramId: inserted.diagramId, expectedRevision: inserted.revision,
    operations: [{ op: 'insert_custom_shape', shapeId: 'plain-box', idPrefix: 'atomic', x: 900, y: 180 },
      { op: 'insert_custom_shape', shapeId: 'not-installed', idPrefix: 'missing', x: 900, y: 300 }] } });
  expect(failed.isError).toBe(true);
  expect((await call('get_diagram')).elements).toEqual(inserted.elements);
  await page.getByTestId('sidebar-close').click();
  await page.getByTestId('editor').click({ position: { x: 950, y: 700 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await call('get_diagram')).elements).toEqual(baseline.elements);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await call('get_diagram')).elements.length).toBe(inserted.elements.length);
  await apply([{ op: 'insert_custom_shape', shapeId: 'browser-flow', idPrefix: 'second', x: 850, y: 430 }]);
  expect(await diskShapes(page)).toEqual(saved);
  await shapesMenu(page);
  await page.getByRole('button', { name: 'Reset library', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(async () => (await call('list_custom_shapes')).total).toBe(0);
  const exported = await rawScene();
  expect(exported.elements.some((item: any) => item.id === id('link'))).toBe(true);
  const beforeReload = (await call('get_diagram')).elements;
  await page.reload(); await readyCanvas(page, false);
  expect((await call('list_custom_shapes')).total).toBe(0);
  expect((await call('get_diagram')).elements).toEqual(beforeReload);
});

test('native file imports normalize legacy references and anchors, export, and recover from storage failure', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'settings' && key === 'customShapes' && sessionStorage.getItem('fail-shapes')) throw new DOMException('Full', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  await mockLibrary(page, simpleFile()); await install(page);
  const prior = await diskShapes(page);
  // Older catalog libraries use boundElementIds, include links outside a saved
  // selection, and have focus values outside [-1, 1] (System Design Components).
  const legacy = { type: 'excalidrawlib', version: 1, library: [[
    { ...rectangle('old-a'), boundElements: undefined, boundElementIds: ['old-arrow', 'missing-arrow'] },
    { ...rectangle('old-b'), x: 300, boundElements: undefined, boundElementIds: ['old-arrow'], frameId: 'missing-frame' },
    { ...rectangle('old-arrow'), type: 'arrow', x: 150, y: 70, width: 140, height: 0, points: [[0, 0], [140, 0]],
      startBinding: { elementId: 'old-a', focus: 3.2890502365576073, gap: 10 },
      endBinding: { elementId: 'old-b', focus: -1.3793878506756339, gap: 10 }, endArrowhead: 'arrow' },
  ]] };
  await page.evaluate(() => sessionStorage.setItem('fail-shapes', 'true'));
  await shapesMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('lib-dropdown--load').click();
  await (await chooser).setFiles({ name: 'legacy.excalidrawlib', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await expect(page.getByRole('alert').filter({ hasText: 'Custom shapes could not be saved' })).toBeVisible();
  expect(await call('list_custom_shapes')).toMatchObject({ total: 2, saveStatus: 'unsaved' });
  expect(await diskShapes(page)).toEqual(prior);
  await page.evaluate(() => sessionStorage.removeItem('fail-shapes'));
  await page.getByRole('button', { name: 'Retry saving custom shapes' }).click();
  await expect.poll(async () => (await call('list_custom_shapes')).saveStatus).toBe('saved');
  const installed = (await diskShapes(page)).find(item => item.id !== 'plain-box');
  const arrow = installed.elements.find((item: any) => item.id === 'old-arrow');
  expect(arrow.startBinding).toMatchObject({ elementId: 'old-a', focus: 1 });
  expect(arrow.endBinding).toMatchObject({ elementId: 'old-b', focus: -1 });
  expect(installed.elements.find((item: any) => item.id === 'old-a').boundElements).toEqual([{ id: 'old-arrow', type: 'arrow' }]);
  expect(installed.elements.find((item: any) => item.id === 'old-b').frameId).toBeNull();
  await shapesMenu(page);
  const download = page.waitForEvent('download');
  await page.getByTestId('lib-dropdown--export').click();
  const saved = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(saved.type).toBe('excalidrawlib'); expect(saved.libraryItems).toHaveLength(2);
  await page.reload(); await readyCanvas(page, false);
  expect((await call('list_custom_shapes')).total).toBe(2);
  const result = await apply([{ op: 'insert_custom_shape', shapeId: installed.id, idPrefix: 'legacy', x: 100, y: 200 }]);
  expect(result.saveStatus).toBe('saved');
  await rawScene(); // The normalized template is also a valid portable diagram.
  await page.context().unroute(sourceURL);
  await mockLibrary(page, legacy); await install(page);
  expect((await call('list_custom_shapes')).total).toBe(2); // Legacy reimports generate new IDs, but not new templates.
});

test('catalog return can open a fresh workspace, cancel safely, and retry an invalid download', async ({ page }) => {
  await mockLibrary(page, simpleFile());
  await page.goto(callback());
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await expect(review(page).getByRole('button', { name: 'Add shapes', exact: true })).toBeEnabled();
  expect(new URL(page.url()).search).toBe('');
  await review(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await diskShapes(page)).toEqual([]);
  await page.context().unroute(sourceURL);
  await mockLibrary(page, { type: 'not-a-library' });
  await page.evaluate(url => { location.hash = 'addLibrary=' + encodeURIComponent(url); }, sourceURL);
  await expect(review(page).getByRole('alert')).toContainText('Choose an .excalidrawlib');
  expect(await diskShapes(page)).toEqual([]);
  await page.context().unroute(sourceURL);
  await mockLibrary(page, simpleFile());
  await review(page).getByRole('button', { name: 'Retry download' }).click();
  await review(page).getByRole('button', { name: 'Add shapes', exact: true }).click();
  await expect(review(page)).toBeHidden();
  expect(await diskShapes(page)).toHaveLength(1);
  const bad = await page.context().newPage();
  await bad.goto(callback('https://example.com/untrusted.excalidrawlib'));
  await expect(bad.getByRole('heading', { name: 'Could not open this shape library' })).toBeVisible();
  await bad.close();
  expect(await diskShapes(page)).toHaveLength(1);
});
