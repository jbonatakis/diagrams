import { test, expect, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DiagramSnapshot } from '../src/editor/controller';
import type { Operation } from '../src/protocol';

const token = 'phase-one-browser-test-token-not-a-secret';
const endpoint = 'http://127.0.0.1:4180/mcp';
let client: Client;

test.beforeEach(async () => {
  client = new Client({ name: 'phase-one-browser-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
test.afterEach(async ({ page }) => {
  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  if (await disconnect.isVisible().catch(() => false)) await disconnect.click();
  await client.close();
});

async function connect(page: Page) {
  await page.goto('/');
  await page.getByLabel('Connection token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect this canvas' }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Connected');
}

async function read(): Promise<DiagramSnapshot> {
  const result = await client.callTool({ name: 'get_diagram', arguments: {} });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const { saveStatus: _save, ...snapshot } = result.structuredContent as DiagramSnapshot & { saveStatus: string };
  return snapshot;
}

async function apply(state: DiagramSnapshot, operations: Operation[]) {
  return client.callTool({ name: 'apply_operations', arguments: { diagramId: state.diagramId, expectedRevision: state.revision, operations } });
}

const sample: Operation[] = [
  { op: 'create_shape', id: 'browser', shape: 'rectangle', x: 250, y: 230, width: 180, height: 100, label: 'Browser', fill: '#e9f0e5' },
  { op: 'create_shape', id: 'agent', shape: 'rectangle', x: 650, y: 230, width: 180, height: 100, label: 'Agent', fill: '#eee9f7' },
  { op: 'connect', id: 'link', fromId: 'browser', toId: 'agent', strokeStyle: 'dashed', startArrowhead: 'arrow', endArrowhead: 'arrow' },
];

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const bounds = await page.getByTestId('editor').boundingBox();
  if (!bounds) throw new Error('Canvas missing');
  await page.keyboard.press('v');
  await page.mouse.move(bounds.x + from[0], bounds.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(bounds.x + to[0], bounds.y + to[1], { steps: 12 });
  await page.mouse.up();
}

test('agent creates a diagram, human moves a shape, agent reads and moves it, undo preserves the human edit', async ({ page, browser }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await connect(page);
  const created = await apply(await read(), sample);
  expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
  await expect(page.getByTestId('scene-stats')).toContainText('3 elements');
  const before = await read();
  expect(before.elements.map((element) => element.id)).toEqual(['browser', 'agent', 'link']);
  expect(before.elements.find((element) => element.id === 'link')).toMatchObject({ fromId: 'browser', toId: 'agent', strokeStyle: 'dashed', startArrowhead: 'arrow', endArrowhead: 'arrow' });

  // Use the real canvas pointer interaction, without any test-only editor API.
  await drag(page, [270, 250], [330, 330]);
  await expect.poll(async () => (await read()).elements.find((element) => element.id === 'browser')!.x).toBeGreaterThan(290);
  const human = await read();
  const humanBox = human.elements.find((element) => element.id === 'browser')!;
  expect(humanBox.y).toBeGreaterThan(280);
  expect(human.elements.find((element) => element.id === 'link')!.points).not.toEqual(before.elements.find((element) => element.id === 'link')!.points);

  const moved = await apply(human, [{ op: 'move', id: 'browser', x: 180, y: 460 }]);
  expect(moved.isError, JSON.stringify(moved.content)).not.toBe(true);
  const agent = await read();
  expect(agent.elements.find((element) => element.id === 'browser')).toMatchObject({ x: 180, y: 460 });
  expect(agent.elements.find((element) => element.id === 'link')!.points).not.toEqual(human.elements.find((element) => element.id === 'link')!.points);
  await page.screenshot({ path: testInfo.outputPath('agent-and-human.png') });

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => {
    const box = (await read()).elements.find((element) => element.id === 'browser');
    return box && { x: box.x, y: box.y };
  }).toEqual({ x: humanBox.x, y: humanBox.y });
  const undone = await read();
  const undoneArrow = undone.elements.find((element) => element.id === 'link')!;
  expect(undoneArrow).toMatchObject({ fromId: 'browser', toId: 'agent', strokeStyle: 'dashed', startArrowhead: 'arrow', endArrowhead: 'arrow' });
  expect(undone.elements).toHaveLength(3);

  // Native undo redraws bound arrows, so exact pre-undo endpoint equality is
  // not the editor's contract. Compare with an otherwise identical human-only
  // move + undo, rather than masking connector regressions with a loose tolerance.
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(async () => (await client.callTool({ name: 'get_diagram', arguments: {} })).isError).toBe(true);
  const controlContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: 'http://127.0.0.1:4180' });
  const control = await controlContext.newPage();
  control.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await connect(control);
    expect((await apply(await read(), sample)).isError).not.toBe(true);
    await expect(control.getByTestId('scene-stats')).toContainText('3 elements');
    await drag(control, [270, 250], [330, 330]);
    const controlHuman = await read();
    expect(controlHuman.elements).toEqual(human.elements);
    await drag(control, [330, 330], [200, 480]);
    await expect.poll(async () => {
      const box = (await read()).elements.find((element) => element.id === 'browser');
      return box && { x: box.x, y: box.y };
    }).toEqual({ x: 180, y: 460 });
    await control.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => {
      const box = (await read()).elements.find((element) => element.id === 'browser');
      return box && { x: box.x, y: box.y };
    }).toEqual({ x: humanBox.x, y: humanBox.y });
    const nativeUndone = await read();
    await testInfo.attach('undo-comparison', {
      body: JSON.stringify({ human, agentUndo: undone, nativeUndo: nativeUndone }, null, 2),
      contentType: 'application/json',
    });
    expect(undone.elements.filter((element) => element.type !== 'arrow')).toEqual(nativeUndone.elements.filter((element) => element.type !== 'arrow'));
    const nativeArrow = nativeUndone.elements.find((element) => element.id === 'link')!;
    const { x, y, width, height, points, ...nativeArrowProperties } = nativeArrow;
    expect(undoneArrow).toMatchObject(nativeArrowProperties);
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      expect(undoneArrow[field]).toBeCloseTo(nativeArrow[field], 8);
    }
    expect(undoneArrow.points).toHaveLength(points!.length);
    points!.forEach((point, index) => point.forEach((coordinate, axis) => {
      expect(undoneArrow.points![index][axis]).toBeCloseTo(coordinate, 8);
    }));
  } finally {
    await controlContext.close();
  }
  expect(pageErrors).toEqual([]);
});

test('batch is one undo step and can be redone', async ({ page }) => {
  await connect(page);
  expect((await apply(await read(), sample)).isError).not.toBe(true);
  await expect(page.getByTestId('scene-stats')).toContainText('3 elements');
  await page.getByTestId('editor').click({ position: { x: 900, y: 600 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await read()).elements.length).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await read()).elements.length).toBe(3);
});

test('stale revisions and invalid batches leave the live diagram unchanged', async ({ page }) => {
  await connect(page);
  const empty = await read();
  await apply(empty, sample);
  const current = await read();
  const stale = await apply(empty, [{ op: 'move', id: 'browser', x: 10, y: 10 }]);
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale.content)).toContain('revision_conflict');
  const bad = await apply(current, [
    { op: 'create_shape', id: 'must-not-exist', shape: 'ellipse', x: 50, y: 50 },
    { op: 'connect', id: 'bad-link', fromId: 'must-not-exist', toId: 'missing' },
  ]);
  expect(bad.isError).toBe(true);
  expect(await read()).toEqual(current);
  const wrongDiagram = await apply({ ...current, diagramId: '00000000-0000-0000-0000-000000000000' }, [{ op: 'move', id: 'browser', x: 10, y: 10 }]);
  expect(wrongDiagram.isError).toBe(true);
  expect(JSON.stringify(wrongDiagram.content)).toContain('diagram_changed');
  const invalid = await client.callTool({ name: 'apply_operations', arguments: { diagramId: current.diagramId, expectedRevision: current.revision, operations: [{ op: 'move', id: 'browser', x: 'invalid', y: 10 }] } });
  expect(invalid.isError).toBe(true);
  expect(await read()).toEqual(current);
});

test('only an authenticated browser can connect and only one owns the diagram', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Connection token', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Connect this canvas' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid connection token');
  await connect(page);
  const first = await read();
  const secondContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4180' });
  const second = await secondContext.newPage();
  await second.goto('/');
  await second.getByLabel('Connection token', { exact: true }).fill(token);
  await second.getByRole('button', { name: 'Connect this canvas' }).click();
  await expect(second.getByRole('alert')).toContainText('Another browser is connected');
  expect((await read()).diagramId).toBe(first.diagramId);
  await secondContext.close();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect.poll(async () => (await client.callTool({ name: 'get_diagram', arguments: {} })).isError).toBe(true);
});
