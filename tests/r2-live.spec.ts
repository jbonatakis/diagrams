import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { connectAgent, origin } from './connection-helpers';

// This opt-in test uses a fresh browser context and generated diagrams. Never
// record traces/screenshots containing bearer download or upload URLs.
test.use({ trace: 'off', screenshot: 'off' });

test('live hosted exports render every format and survive closing the diagram tab', async ({ page }) => {
  const permittedOrigin = origin === 'http://localhost:5173' ||
    (origin === 'https://diagrams.bonatak.is' && process.env.DIAGRAMS_R2_PRODUCTION_TEST === 'true');
  test.skip(process.env.DIAGRAMS_R2_LIVE_TEST !== 'true' || !permittedOrigin, 'Requires explicit live-export opt-in; production requires a second opt-in');
  test.setTimeout(120_000);
  const client = await connectAgent(page);
  const jobs: any[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, `${name} failed`).not.toBe(true);
    return response.structuredContent as any;
  };
  const get = async (url: string, init?: RequestInit) => {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Fixture download failed; URL details suppressed.'); }
  };
  try {
    const initial = await call('get_diagram');
    const scene = await call('apply_operations', {
      diagramId: initial.diagramId, expectedRevision: initial.revision,
      operations: [{ op: 'create_shape', id: 'r2-smoke-fixture', shape: 'rectangle', x: 30, y: 40, width: 180, height: 100, label: 'Generated R2 proof' }],
    });
    for (const format of ['svg', 'png', 'excalidraw', 'library']) {
      const name = format === 'library' ? 'export_library' : 'export_diagram';
      const args = { delivery: 'download', requestId: randomUUID(), ...(format === 'library' ? { includeTrash: true } : { diagramId: scene.diagramId, format }) };
      const started = await call(name, args);
      jobs.push(started);
      let ready: any;
      await expect.poll(async () => {
        ready = await call('get_export', { exportId: started.exportId });
        if (['failed', 'cancelled', 'expired'].includes(ready.status)) throw new Error(`Generated ${format} export ended with ${ready.status}: ${ready.error ?? ''}`);
        return ready.status;
      }, { timeout: 45000, intervals: [500, 1000, 2000] }).toBe('ready');
      const replay = await call(name, args);
      expect(replay.exportId).toBe(ready.exportId);
      expect(replay.expiresAt).toBe(ready.expiresAt);
      expect(replay.sha256).toBe(ready.sha256);
      if (format !== 'library') expect(ready.revision).toBe(scene.revision);
      await expect(page.locator('.hosted-export-notice')).toHaveCount(0);
      jobs[jobs.length - 1] = { ...ready, format };
    }
    await page.close();
    for (const job of jobs) {
      const status = await call('get_export', { exportId: job.exportId });
      expect(status.status).toBe('ready');
      expect(status.expiresAt).toBe(job.expiresAt);
      const head = await get(status.downloadUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get('content-length'))).toBe(status.sizeBytes);
      const redirect = await get(status.downloadUrl, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      const response = await get(redirect.headers.get('location')!);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBe(status.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(status.sha256);
      if (job.format === 'svg') expect(bytes.toString()).toContain('<svg');
      if (job.format === 'png') expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      if (job.format === 'excalidraw') expect(JSON.parse(bytes.toString()).elements.some((item: any) => item.id === 'r2-smoke-fixture')).toBe(true);
      if (job.format === 'library') {
        const backup = JSON.parse(bytes.toString());
        expect(backup.type).toBe('diagrams-library');
        expect(backup.diagrams.length).toBe(status.diagramCount);
        expect(backup.diagrams[0].document.elements.some((item: any) => item.id === 'r2-smoke-fixture')).toBe(true);
      }
      const cancelled = await call('cancel_export', { exportId: job.exportId });
      expect(cancelled.status).toBe('cancelled');
      expect((await get(status.downloadUrl, { redirect: 'manual' })).status).toBe(404);
    }
  } finally {
    for (const job of jobs) await client.callTool({ name: 'cancel_export', arguments: { exportId: job.exportId } }).catch(() => {});
    await client.close();
  }
});
