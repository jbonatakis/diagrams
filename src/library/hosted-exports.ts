import { CommandError, type Command } from '../protocol';
import type { DiagramBlob } from './scene';

export type HostedJob = { version: 1; exportId: string; kind: 'diagram' | 'library'; diagramId: string; format: 'svg' | 'png' | 'excalidraw' | 'json'; includeTrash: boolean; deadline: number };
export type HostedSnapshotMetadata = { revision: number } | { diagramCount: number; snapshotAt: string; sourceRevisions: { diagramId: string; revision: number }[] };
export type HostedSnapshot = { metadata: HostedSnapshotMetadata; render: () => Promise<DiagramBlob> };
export type HostedNotice = { exportId: string; status: 'preparing' | 'uploading' | 'verifying' | 'ready' | 'failed' | 'cancelled'; filename?: string; downloadUrl?: string; expiresAt?: string };
const event = (detail: HostedNotice) => window.dispatchEvent(new CustomEvent('diagrams-hosted-export', { detail }));
const validID = (value: unknown): value is string => typeof value === 'string' && /^exp_[a-zA-Z0-9_-]{16,80}$/.test(value);

function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function request(url: string, init: RequestInit, signal: AbortSignal, timeout = 15000) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Read bounded app metadata while the timeout is still active. R2 PUT
    // responses are discarded; no provider body is forwarded to the server.
    const data = init.method === 'POST' && response.ok && response.status !== 204 ? await response.json() : undefined;
    return { response, data };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export class HostedExports {
  private active = new Map<string, AbortController>();
  private seen = new Map<string, { fingerprint: string; deadline: number }>();
  constructor(private capture: (job: HostedJob, signal: AbortSignal) => Promise<HostedSnapshot>) {}

  execute(command: Command) {
    if (Date.now() > command.deadline) throw new CommandError('expired_request', 'Export command expired.');
    const args = command.arguments as Partial<HostedJob> | undefined;
    if (!args || !validID(args.exportId)) throw new CommandError('invalid_export_job', 'Invalid hosted export job.');
    if (command.tool === '__cancel_hosted_export') {
      this.active.get(args.exportId)?.abort(new CommandError('export_cancelled', 'Export cancelled.'));
      if (!this.seen.has(args.exportId)) this.seen.set(args.exportId, { fingerprint: 'cancelled', deadline: Date.now() + 600000 });
      event({ exportId: args.exportId, status: 'cancelled' });
      return { cancelled: true };
    }
    if (args.version !== 1 || !['diagram', 'library'].includes(args.kind ?? '') || typeof args.deadline !== 'number' || !Number.isFinite(args.deadline) || args.deadline <= Date.now() || args.deadline > Date.now() + 610000 || typeof args.includeTrash !== 'boolean'
      || (args.kind === 'diagram' && (typeof args.diagramId !== 'string' || !args.diagramId || !['svg', 'png', 'excalidraw'].includes(args.format ?? '')))
      || (args.kind === 'library' && args.format !== 'json')) throw new CommandError('invalid_export_job', 'Invalid hosted export job.');
    const job = args as HostedJob;
    for (const [id, entry] of this.seen) if (entry.deadline < Date.now() && !this.active.has(id)) this.seen.delete(id);
    const fingerprint = JSON.stringify([job.version, job.kind, job.diagramId, job.format, job.includeTrash, job.deadline]);
    const previous = this.seen.get(job.exportId);
    if (previous && previous.fingerprint !== fingerprint) throw new CommandError('invalid_export_job', 'Export ID was already used or cancelled.');
    if (!previous) {
      if (this.active.size >= 2) throw new CommandError('export_limit', 'Two hosted exports are already running.');
      this.seen.set(job.exportId, { fingerprint, deadline: job.deadline });
      const controller = new AbortController();
      this.active.set(job.exportId, controller);
      const timer = setTimeout(() => controller.abort(new CommandError('export_timeout', 'Export timed out.')), job.deadline - Date.now());
      event({ exportId: job.exportId, status: 'preparing' });
      void this.run(job, controller.signal).finally(() => { clearTimeout(timer); this.active.delete(job.exportId); });
    }
    return { accepted: true, version: 1, exportId: job.exportId };
  }

  private async post(id: string, action: string, body: unknown, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const { response, data } = await request(`/api/exports/${encodeURIComponent(id)}/${action}`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        }, signal);
        if (response.ok) return { status: response.status, data };
        if (response.status < 500 && response.status !== 429) throw new CommandError('export_failed', 'Export is no longer available.');
        if (attempt >= 2) throw new CommandError('export_unavailable', 'Export service is temporarily unavailable.');
      } catch (error) {
        if (error instanceof CommandError || signal.aborted || attempt >= 2) throw error;
      }
      await pause(500 * (attempt + 1), signal);
    }
  }

  private async run(job: HostedJob, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const snapshot = await this.capture(job, signal);
      signal.throwIfAborted();
      await this.post(job.exportId, 'captured', snapshot.metadata, signal);
      const file = await snapshot.render();
      signal.throwIfAborted();
      if (!file.blob.size || file.blob.size > 64 * 1024 * 1024) throw new CommandError('export_too_large', 'Hosted exports are limited to 64 MiB.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer()));
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      const checksumSHA256 = btoa(String.fromCharCode(...digest));
      const authorization = await this.post(job.exportId, 'upload', { ...snapshot.metadata, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.blob.size, sha256, checksumSHA256 }, signal);
      const grant = authorization.data as { url: string; headers: Record<string, string> };
      event({ exportId: job.exportId, status: 'uploading' });
      // Retry exactly the same conditional PUT. A lost success response may
      // produce 412 on retry; the server verifies the existing object below.
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        try {
          const { response } = await request(grant.url, { method: 'PUT', headers: grant.headers, body: file.blob, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }, signal, Math.min(120000, job.deadline - Date.now()));
          if (response.ok || response.status === 412) break;
          if (response.status < 500 && response.status !== 429 && response.status !== 409) break;
        } catch { signal.throwIfAborted(); }
        if (attempt < 2) await pause(500 * (attempt + 1), signal);
      }
      event({ exportId: job.exportId, status: 'verifying' });
      while (true) {
        signal.throwIfAborted();
        try {
          const completed = await this.post(job.exportId, 'complete', undefined, signal);
          if (completed.status === 200 && completed.data?.status === 'ready') {
            event({ exportId: job.exportId, status: 'ready', filename: completed.data.filename, downloadUrl: completed.data.downloadUrl, expiresAt: completed.data.expiresAt });
            return;
          }
        } catch (error) {
          if (signal.aborted || (error instanceof CommandError && error.code === 'export_failed')) throw error;
          // Completion is uncertain. Retain the same job and poll; the server
          // independently bounds reconciliation to three provider requests.
        }
        await pause(10000, signal);
      }
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      const code = reason instanceof CommandError ? reason.code : 'export_failed';
      event({ exportId: job.exportId, status: code === 'export_cancelled' ? 'cancelled' : 'failed' });
      const failureController = new AbortController();
      void request(`/api/exports/${encodeURIComponent(job.exportId)}/failed`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }, failureController.signal, 3000).catch(() => {});
    }
  }

  dispose() { for (const controller of this.active.values()) controller.abort(new CommandError('export_cancelled', 'Workspace closed.')); }
}
