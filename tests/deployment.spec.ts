import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import type { DiagramSnapshot } from '../src/editor/controller';
import { connectAgent, origin } from './connection-helpers';

test('browser and agent reconnect after container recreation with pairings intact', async ({ page }) => {
  const project = process.env.DIAGRAMS_TEST_COMPOSE_PROJECT ?? '';
  // This test may recreate only the temporary project created by verify:docker.
  test.skip(!/^diagrams-check-[a-f0-9]{8}$/.test(project), 'Requires npm run verify:docker');
  test.setTimeout(90_000);
  const client = await connectAgent(page);
  const read = async () => {
    const result = await client.callTool({ name: 'get_diagram', arguments: {} });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as DiagramSnapshot;
  };
  const initial = await read();
  const result = await client.callTool({ name: 'apply_operations', arguments: {
    diagramId: initial.diagramId, expectedRevision: initial.revision,
    operations: [{ op: 'create_shape', id: 'survives-deployment', shape: 'rectangle', x: 250, y: 250, label: 'Still connected' }],
  } });
  expect(result.isError).not.toBe(true);
  await expect(page.getByTestId('save-status')).toHaveText('Saved in browser');
  const before = await read();

  await promisify(execFile)('docker', ['compose', '--project-name', project, '--env-file', 'deploy/production.env.example',
    'up', '-d', '--force-recreate', '--no-build', '--wait', '--wait-timeout', '60'], { timeout: 70_000 });
  // The browser reconnects its WebSocket; the same client token remains valid.
  await expect.poll(async () => {
    try { return (await read()).diagramId; } catch { return undefined; }
  }, { timeout: 20_000 }).toBe(before.diagramId);
  expect((await read()).elements).toEqual(before.elements);
  await page.reload();
  await expect(page.getByTestId('connection-status')).toHaveText('Canvas ready');
  expect((await read()).elements).toEqual(before.elements);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revoke Browser test agent', exact: true })).toBeVisible();
  const response = await page.request.get(origin + '/healthz');
  expect(response.status()).toBe(200);
});
