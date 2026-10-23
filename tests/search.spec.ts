import { test, expect } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectAgent } from './connection-helpers';
import type { DiagramSnapshot } from '../src/editor/controller';
import type { Operation } from '../src/protocol';

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent;
}
async function read(client: Client): Promise<DiagramSnapshot> { return call(client, 'get_diagram'); }
async function apply(client: Client, operations: Operation[]): Promise<DiagramSnapshot> {
  const current = await read(client);
  return call(client, 'apply_operations', { diagramId: current.diagramId, expectedRevision: current.revision, operations });
}

test('compact find navigates text and labels, coexists with custom shapes, and preserves edits and undo', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  await apply(client, [
    { op: 'create_text', id: 'near', x: 200, y: 120, text: 'Browser → BROWSER' },
    { op: 'create_shape', id: 'remote', shape: 'rectangle', x: 4000, y: 2000, width: 220, height: 100, label: 'Browser storage' },
    { op: 'create_text', id: 'literal', x: 250, y: 300, text: 'a+b [draft]' },
  ]);
  const before = await read(client);
  await expect(page.getByRole('search', { name: 'Find in diagram' })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByRole('searchbox', { name: 'Find text in diagram' });
  const search = page.getByRole('search', { name: 'Find in diagram' });
  const count = search.getByRole('status');
  await expect(input).toBeFocused();
  await input.fill('browser');
  await expect(count).toHaveText('1 of 3');
  await input.press('Enter');
  await expect(count).toHaveText('2 of 3');
  await search.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(count).toHaveText('3 of 3');
  await expect.poll(async () => (await read(client)).viewport.scrollX).toBeLessThan(-2500);
  await input.press('Enter');
  await expect(count).toHaveText('1 of 3');
  await input.press('Shift+Enter');
  await expect(count).toHaveText('3 of 3');

  await page.getByTitle('Custom Shapes', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Custom Shapes', exact: true })).toBeChecked();
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(page.locator('.sidebar-tab-trigger[aria-controls$="-content-search"]')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('library')).toBeVisible();
  await input.fill('a+b [draft]');
  await expect(count).toHaveText('1 of 1');
  await input.fill('missing text');
  await expect(count).toHaveText('No matches');
  await expect(search.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
  await input.fill('browser');
  await expect(count).toHaveText('1 of 3');
  await page.screenshot({ path: info.outputPath('canvas-find-desktop.png') });
  const searched = await read(client);
  expect(searched.elements).toEqual(before.elements);
  expect(searched.revision).toBe(before.revision);
  expect(searched.selectedElementIds).toEqual(before.selectedElementIds);

  await apply(client, [{ op: 'update', id: 'remote', changes: { text: 'Local storage' } }]);
  await expect(count).toHaveText('1 of 2');
  await input.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(page.locator('.excalidraw')).toBeFocused();
  await page.getByTestId('sidebar-close').click();
  await page.locator('.excalidraw').click({ position: { x: 850, y: 650 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await read(client)).elements).toEqual(before.elements);
  expect(errors).toEqual([]);
});

test('mobile find handles wrapping, switches diagrams, and starts closed after reload', async ({ page }, info) => {
  const client = await connectAgent(page);
  await page.getByRole('button', { name: 'Close agent panel' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const scene = await apply(client, [
    { op: 'create_shape', id: 'wrapped', shape: 'rectangle', x: 150, y: 160, width: 120, height: 100, label: 'browser saves diagrams locally' },
    { op: 'create_text', id: 'multiline', x: 150, y: 400, text: 'First line\nBrowser saves diagrams locally', fontSize: 20 },
  ]);
  await page.getByRole('button', { name: 'Find in diagram', exact: true }).click();
  const search = page.getByRole('search', { name: 'Find in diagram' });
  const input = search.getByRole('searchbox');
  await expect(input).toBeFocused();
  await input.fill('saves diagrams');
  await expect(search.getByRole('status')).toHaveText('1 of 2');
  await search.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(search.getByRole('status')).toHaveText('2 of 2');
  const box = await search.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await input.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('canvas-find-mobile.png') });
  const created = await call(client, 'create_diagram', { name: 'Empty diagram' });
  await call(client, 'open_diagram', { diagramId: created.id, expectedActiveDiagramId: scene.diagramId, expectedActiveRevision: scene.revision });
  await expect(input).toHaveValue('');
  await input.fill('browser');
  await expect(search.getByRole('status')).toHaveText('No matches');
  await page.reload();
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await expect(search).toHaveCount(0);
});
