import { test, expect } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DiagramSnapshot } from '../src/editor/controller';
import { authorizeAgent, connectAgent, openAgentPanel, readyCanvas } from './connection-helpers';

async function read(client: Client) {
  const result = await client.callTool({ name: 'get_diagram', arguments: {} });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as DiagramSnapshot;
}

test('pairing survives reload, pausing access and reopening a tab without a token prompt', async ({ page, context }, testInfo) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Agent connection' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up your agent', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await readyCanvas(page, false);
  await expect(page.getByRole('heading', { name: 'Set up your agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up your agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy MCP URL', exact: true })).toBeVisible();
  await expect(page.getByText('No agents approved yet.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('agent-setup.png') });
  const client = await connectAgent(page, false);
  const before = await read(client);
  await expect(page.getByLabel('Connection token', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: 'Agent connection' })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Agent access', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await client.callTool({ name: 'get_diagram', arguments: {} })).isError === true).toBe(false);
  const after = await read(client);
  expect(after.diagramId).toBe(before.diagramId);
  await expect(toggle).not.toHaveClass(/needs-setup/);
  await openAgentPanel(page);
  await expect(page.getByTestId('connection-status')).toHaveText('Canvas ready');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approved agents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause agent access', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Agent access paused');
  await expect.poll(async () => (await client.callTool({ name: 'get_diagram', arguments: {} })).isError).toBe(true);
  await page.reload();
  await openAgentPanel(page);
  await expect(page.getByTestId('connection-status')).toHaveText('Agent access paused');
  await expect(page.getByRole('button', { name: 'Revoke Browser test agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume agent access', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Canvas ready');
  expect((await read(client)).diagramId).toBe(before.diagramId);
  await page.close();
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 390, height: 844 });
  await reopened.goto('/');
  await expect(reopened.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await expect.poll(async () => (await client.callTool({ name: 'get_diagram', arguments: {} })).isError === true).toBe(false);
  await expect(reopened.getByRole('complementary', { name: 'Agent connection' })).toHaveCount(0);
  await reopened.screenshot({ path: testInfo.outputPath('agent-sidebar-closed-mobile.png') });
  await readyCanvas(reopened, false);
  expect((await read(client)).diagramId).toBe(before.diagramId);
  await reopened.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(reopened.getByRole('button', { name: 'Revoke Browser test agent', exact: true })).toBeVisible();
});

test('revoking one agent leaves other approved agents connected', async ({ page }) => {
  const first = await connectAgent(page);
  const second = await authorizeAgent(page, 'Second agent');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke Browser test agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke Browser test agent', exact: true })).toHaveCount(0);
  await expect(first.callTool({ name: 'get_diagram', arguments: {} })).rejects.toThrow();
  expect((await second.callTool({ name: 'get_diagram', arguments: {} })).isError).not.toBe(true);
});

test('forgetting a browser revokes access but preserves locally saved diagrams', async ({ page }) => {
  const client = await connectAgent(page);
  const before = await read(client);
  const state = before;
  const edit = await client.callTool({ name: 'apply_operations', arguments: {
    diagramId: state.diagramId, expectedRevision: state.revision,
    operations: [{ op: 'create_shape', id: 'kept-locally', shape: 'rectangle', x: 250, y: 230, label: 'Still here' }],
  } });
  expect(edit.isError).not.toBe(true);
  await client.callTool({ name: 'list_diagrams', arguments: {} });
  await page.getByRole('button', { name: 'Forget this browser', exact: true }).click();
  await page.getByRole('button', { name: 'Forget pairings', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Agent access paused');
  await expect(client.callTool({ name: 'get_diagram', arguments: {} })).rejects.toThrow();
  await page.reload();
  await expect(page.getByTestId('scene-stats')).toContainText('1 elements');
  await openAgentPanel(page);
  await page.getByRole('button', { name: 'Resume agent access', exact: true }).click();
  await expect(page.getByTestId('connection-status')).toHaveText('Canvas ready');
  const replacement = await authorizeAgent(page, 'New pairing');
  const recovered = await read(replacement);
  expect(recovered.diagramId).toBe(state.diagramId);
  expect(recovered.elements).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'kept-locally' })]));
});

test('canceling consent grants no access and keeps the drawing tab usable', async ({ page }) => {
  await readyCanvas(page);
  await expect(authorizeAgent(page, 'Declined agent', false)).rejects.toThrow('Authorization declined');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No agents approved yet.')).toBeVisible();
  await expect(page.getByLabel('Diagram name', { exact: true })).toBeEnabled();
  await page.getByLabel('Diagram name', { exact: true }).fill('Still drawing');
  await page.getByLabel('Diagram name', { exact: true }).press('Enter');
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
});

