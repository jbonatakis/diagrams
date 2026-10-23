import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { connectAgent, origin } from './connection-helpers';

type StoredExport = { captured?: any; metadata?: any; bytes?: Buffer; completed?: boolean; captures: number; puts: number };
async function setup(page: Page, loseFirstPut = false, holdUpload = false) {
  let socket: WebSocketRoute;
  const jobs = new Map<string, StoredExport>();
  let releaseUpload = () => {};
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.routeWebSocket('**/api/bridge', route => { socket = route; route.connectToServer(); });
  await page.route('**/api/exports/*/*', async route => {
    const url = new URL(route.request().url());
    const [, , , id, action] = url.pathname.split('/');
    const job = jobs.get(id) ?? { captures: 0, puts: 0 };
    jobs.set(id, job);
    if (action === 'captured') {
      job.captured = route.request().postDataJSON(); job.captures++;
      await route.fulfill({ status: 204 });
    } else if (action === 'upload') {
      job.metadata = route.request().postDataJSON();
      await route.fulfill({ json: { url: `https://r2.example.test/${id}`, headers: { 'Content-Type': job.metadata.mimeType, 'If-None-Match': '*' } } });
    } else if (action === 'complete') {
      expect(job.bytes).toBeDefined();
      expect(job.metadata.sizeBytes).toBe(job.bytes!.length);
      expect(job.metadata.sha256).toBe(createHash('sha256').update(job.bytes!).digest('hex'));
      expect(job.metadata.checksumSHA256).toBe(createHash('sha256').update(job.bytes!).digest('base64'));
      await route.fulfill({ json: { status: 'ready', exportId: id, filename: job.metadata.filename, downloadUrl: `${origin}/export/${id}?token=fixture`, expiresAt: new Date(Date.now() + 900000).toISOString() } });
      job.completed = true;
    } else await route.fulfill({ status: 204 });
  });
  await page.route('https://r2.example.test/*', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': '*' } }); return;
    }
    const id = new URL(route.request().url()).pathname.slice(1);
    const job = jobs.get(id)!;
    job.puts++;
    expect(route.request().headers()['if-none-match']).toBe('*');
    job.bytes ??= route.request().postDataBuffer()!;
    if (holdUpload) await uploadGate;
    if (loseFirstPut && job.puts === 1) { await route.abort('failed'); return; }
    await route.fulfill({ status: job.puts > 1 ? 412 : 200, headers: { 'Access-Control-Allow-Origin': origin } });
  });
  const client = await connectAgent(page);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return response.structuredContent as any;
  };
  const initial = await call('get_diagram');
  const scene = await call('apply_operations', { diagramId: initial.diagramId, expectedRevision: initial.revision, operations: [{ op: 'create_shape', id: 'fixture', shape: 'rectangle', x: 20, y: 40, width: 150, height: 100, label: 'Hosted export fixture' }] });
  const send = (tool: string, args: any) => socket!.send(JSON.stringify({ type: 'command', id: randomUUID(), tool, arguments: args, deadline: Date.now() + 5000 }));
  const start = (format: string, kind = 'diagram', extra: Record<string, unknown> = {}) => {
    const job = { version: 1, exportId: 'exp_' + randomUUID().replaceAll('-', ''), kind, diagramId: scene.diagramId, format, includeTrash: true, deadline: Date.now() + 600000, ...extra };
    send('__hosted_export_job', job);
    return job;
  };
  return { jobs, call, scene, start, send, client, releaseUpload };
}

test('hosted files preserve bytes and retry a lost PUT response using the same snapshot', async ({ page }) => {
  const f = await setup(page, true);
  for (const format of ['svg', 'png', 'excalidraw']) {
    const job = f.start(format);
    f.send('__hosted_export_job', job); // Duplicate transport delivery must not recapture.
    await expect.poll(() => f.jobs.get(job.exportId)?.completed).toBe(true);
    await expect(page.locator('.hosted-export-notice')).toHaveCount(0);
    const result = f.jobs.get(job.exportId)!;
    expect(result.captures).toBe(1); expect(result.puts).toBe(2);
    expect(result.metadata.revision).toBe(f.scene.revision);
    if (format === 'svg') expect(result.bytes!.toString()).toContain('<svg');
    if (format === 'png') expect(result.bytes!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    if (format === 'excalidraw') expect(JSON.parse(result.bytes!.toString()).elements.find((e: any) => e.id === 'fixture').x).toBe(20);
  }
  await f.client.close();
});

test('hosted library rescues unsaved edits and keeps commands available while uploading', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'scenes' && sessionStorage.getItem('hosted-quota') === 'yes') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const f = await setup(page, false, true);
  await page.evaluate(() => sessionStorage.setItem('hosted-quota', 'yes'));
  const edited = await f.call('apply_operations', { diagramId: f.scene.diagramId, expectedRevision: f.scene.revision, operations: [{ op: 'move', id: 'fixture', x: 321, y: 40 }] });
  expect(edited.saveStatus).toBe('error');
  const job = f.start('json', 'library');
  await expect.poll(() => f.jobs.get(job.exportId)?.puts).toBe(1);
  // The PUT is deliberately held open. This edit must complete independently.
  const moved = await f.call('apply_operations', { diagramId: edited.diagramId, expectedRevision: edited.revision, operations: [{ op: 'move', id: 'fixture', x: 999, y: 40 }] });
  expect(moved.revision).toBeGreaterThan(edited.revision);
  f.releaseUpload();
  await expect.poll(() => f.jobs.get(job.exportId)?.completed).toBe(true);
  await expect(page.locator('.hosted-export-notice')).toHaveCount(0);
  const result = f.jobs.get(job.exportId)!;
  const backup = JSON.parse(result.bytes!.toString());
  expect(backup.diagrams.find((d: any) => d.id === edited.diagramId).document.elements.find((e: any) => e.id === 'fixture').x).toBe(321);
  expect(result.captured.sourceRevisions).toContainEqual({ diagramId: edited.diagramId, revision: edited.revision });
  expect(result.captured.diagramCount).toBe(backup.diagrams.length);
  await expect(page.getByTestId('save-status')).toHaveText('Save failed');
  await f.client.close();
});

test('cancellation and job deadlines abort pending uploads without a ready notice', async ({ page }) => {
  const f = await setup(page, false, true);
  const cancelled = f.start('excalidraw');
  await expect.poll(() => f.jobs.get(cancelled.exportId)?.puts).toBe(1);
  f.send('__cancel_hosted_export', { exportId: cancelled.exportId });
  await expect(page.getByText('Export cancelled.', { exact: true })).toBeVisible();
  const expired = f.start('excalidraw', 'diagram', { deadline: Date.now() + 1500 });
  await expect.poll(() => f.jobs.get(expired.exportId)?.puts).toBe(1);
  await expect(page.getByText('Hosted export failed.', { exact: true })).toBeVisible();
  f.releaseUpload();
  await expect(page.locator(`a[href*="${cancelled.exportId}"]`)).toHaveCount(0);
  await expect(page.locator(`a[href*="${expired.exportId}"]`)).toHaveCount(0);
  await f.client.close();
});
