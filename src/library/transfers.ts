import { CommandError } from '../protocol';
import { byteLength, MAX_LIBRARY_BYTES } from './scene';

const TTL = 5 * 60_000;
const CHUNK = 16_000;
type Export = { filename: string; mimeType: string; encoding: 'utf8' | 'base64'; data: string };
type Entry = { bytes: number; expiresAt: number; data: string; kind: 'diagram' | 'library' | 'export'; file?: Export };

export class Transfers {
  private entries = new Map<string, Entry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private clean() { for (const [id, item] of this.entries) if (item.expiresAt <= Date.now()) this.finish(id); }
  private get(id: string) {
    this.clean(); const item = this.entries.get(id);
    if (!item) throw new CommandError('transfer_expired', 'This transfer has expired. Start a new import or export.');
    return item;
  }
  private put(entry: Entry) {
    this.clean();
    if (this.entries.size >= 8) throw new CommandError('transfer_limit', 'Finish or wait for earlier transfers to expire before starting another.');
    this.checkSize(entry.data.length);
    const id = crypto.randomUUID(); this.entries.set(id, entry); this.timers.set(id, setTimeout(() => this.finish(id), TTL)); return id;
  }
  private checkSize(extra: number) {
    const total = [...this.entries.values()].reduce((sum, item) => sum + item.data.length, 0);
    if (total + extra > 96 * 1024 * 1024) throw new CommandError('transfer_limit', 'Pending transfers exceed the browser memory limit. Wait for earlier transfers to expire.');
  }
  export(file: Export) {
    const expiresAt = Date.now() + TTL;
    const id = this.put({ bytes: byteLength(file.data), expiresAt, data: file.data, kind: 'export', file });
    return { artifactId: id, filename: file.filename, mimeType: file.mimeType, encoding: file.encoding,
      sizeBytes: file.encoding === 'base64' ? Math.floor(file.data.length * 3 / 4) - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0) : byteLength(file.data),
      expiresAt: new Date(expiresAt).toISOString(), ...this.read(id, 0, CHUNK) };
  }
  read(id: string, offset: number, length: number) {
    const item = this.get(id);
    if (item.kind !== 'export' || offset > item.data.length) throw new CommandError('invalid_transfer', 'Invalid export or offset.');
    let end = Math.min(offset + length, item.data.length);
    if (end < item.data.length && /[\uD800-\uDBFF]/.test(item.data[end - 1])) end--;
    if (/[\uDC00-\uDFFF]/.test(item.data[offset] ?? '')) throw new CommandError('invalid_transfer', 'Use the nextOffset returned by the previous chunk.');
    return { data: item.data.slice(offset, end), offset, nextOffset: end < item.data.length ? end : null, totalLength: item.data.length };
  }
  begin(kind: 'diagram' | 'library') {
    const expiresAt = Date.now() + TTL;
    return { uploadId: this.put({ kind, bytes: 0, data: '', expiresAt }), chunkSize: 64_000, maxBytes: kind === 'library' ? MAX_LIBRARY_BYTES : 16 * 1024 * 1024, expiresAt: new Date(expiresAt).toISOString() };
  }
  append(id: string, offset: number, data: string) {
    const item = this.get(id);
    if (item.kind === 'export' || item.data.length !== offset) throw new CommandError('invalid_transfer', 'Append chunks in order using nextOffset.');
    if (/[\uD800-\uDBFF]$/.test(data) || /^[\uDC00-\uDFFF]/.test(data)) throw new CommandError('invalid_transfer', 'Keep Unicode surrogate pairs in the same chunk.');
    const bytes = byteLength(data);
    if (bytes > 64_000 || item.bytes + bytes > (item.kind === 'library' ? MAX_LIBRARY_BYTES : 16 * 1024 * 1024)) throw new CommandError('transfer_limit', 'The upload or chunk is too large.');
    this.checkSize(data.length); item.data += data; item.bytes += bytes;
    return { uploadId: id, nextOffset: item.data.length };
  }
  input(args: { data?: string; uploadId?: string }, kind: 'diagram' | 'library') {
    if (args.data !== undefined) return args.data;
    const item = this.get(args.uploadId!);
    if (item.kind !== kind) throw new CommandError('invalid_transfer', 'This upload is for a different file type.');
    return item.data;
  }
  finish(id?: string) { if (id) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.entries.delete(id); } }
  dispose() { for (const id of this.entries.keys()) this.finish(id); }
}
