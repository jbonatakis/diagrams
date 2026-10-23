import type { ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types';
import { CustomShapes } from '../shapes/library';
import { DiagramController } from '../editor/controller';
import { CommandError, validateArguments, type ApplyArguments, type Command, type DeleteDiagramTarget, type ViewArguments } from '../protocol';
import { DiagramStorage, storageError } from './storage';
import { Transfers } from './transfers';
import { byteLength, diagramName, emptyScene, exportDiagram, MAX_DOCUMENT_BYTES, MAX_LIBRARY_BYTES, parseJSON, parseScene, sceneFile, type Diagram, type DiagramMeta, type Scene } from './scene';

const makeDiagram = (name: string, scene = emptyScene()): Diagram => {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, revision: 0, storageVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, scene };
};
const metadata = ({ scene: _scene, operationReceipts: _receipts, ...meta }: Diagram): DiagramMeta => meta;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
async function operationFingerprint(args: ApplyArguments) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(args)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export class Workspace {
  controller?: DiagramController;
  private listeners = new Set<() => void>();
  private documents: DiagramMeta[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private serial = 0;
  private savedSerial = 0;
  private saving?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private transfers = new Transfers();
  private status: SaveStatus = 'saved';
  private error = '';
  private busy = false;
  private editorEpoch = 0;
  private editorAPI?: ExcalidrawImperativeAPI;
  private syncingCustomShapes = false;
  private editorReady?: { resolve: () => void; reject: (error: unknown) => void };
  private state!: ReturnType<Workspace['view']>;

  private constructor(private storage: DiagramStorage, public active: Diagram, public customShapes: CustomShapes, private release: () => void) { this.notify(); }

  static async open() {
    let release = () => {};
    if (!navigator.locks) throw new Error('This browser needs Web Locks support to safely save diagrams. Use a current Chrome, Firefox, or Safari.');
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request('diagrams-library-writer', { ifAvailable: true }, async (lock) => {
        if (!lock) { reject(new Error('Your diagram library is already open in another tab. Close that tab, then retry.')); return; }
        await new Promise<void>((unlock) => { release = unlock; resolve(); });
      }).catch(reject);
    });
    let storage: DiagramStorage | undefined;
    try {
      storage = await DiagramStorage.open();
      const docs = await storage.list();
      const activeId = await storage.activeId();
      const meta = docs.find((item) => item.id === activeId && !item.deletedAt) ?? docs.find((item) => !item.deletedAt);
      let active: Diagram;
      let recoveryMessage = '';
      if (meta) {
        try { active = await storage.get(meta.id); }
        catch {
          try {
            active = { ...meta, revision: meta.revision + 1, scene: await storage.previous(meta.id) };
            active.storageVersion = await storage.save(active, meta.storageVersion, false);
            recoveryMessage = 'Recovered the previous saved version. Export a backup of this diagram.';
          } catch {
            active = makeDiagram('Recovered workspace'); await storage.insert([active]);
            recoveryMessage = 'A saved diagram could not be opened. Its data is preserved in the library; try Recover previous save or import a backup.';
          }
        }
      } else { active = makeDiagram('Untitled diagram'); await storage.insert([active]); }
      await storage.setActive(active.id);
      const workspace = new Workspace(storage, active, await CustomShapes.load(storage), release);
      workspace.error = recoveryMessage;
      await workspace.refresh();
      return workspace;
    } catch (error) { storage?.close(); release(); throw error; }
  }

  private view() {
    return { active: metadata(this.active), documents: this.documents, saveStatus: this.status, error: this.error, busy: this.busy, editorEpoch: this.editorEpoch, snapshot: this.controller?.snapshot() ?? null };
  }
  private notify = () => { this.state = this.view(); for (const listener of this.listeners) listener(); };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  get diagramId() { return this.active.id; }
  get hasUnsavedChanges() { return this.savedSerial !== this.serial || this.status === 'error' || this.customShapes.dirty; }

  attach(api: ExcalidrawImperativeAPI) {
    this.editorAPI = api;
    this.controller?.dispose();
    const controller = new DiagramController(api, this.changed);
    this.controller = controller;
    try { controller.load(this.active); this.editorReady?.resolve(); }
    catch (error) { this.editorReady?.reject(error); this.error = 'Could not load the diagram into the editor. Reload to retry.'; }
    this.editorReady = undefined;
    this.notify();
    return () => { controller.dispose(); if (this.controller === controller) this.controller = undefined; if (this.editorAPI === api) this.editorAPI = undefined; };
  }

  private changed = () => {
    if (!this.controller) return;
    this.active.revision = this.controller.revision;
    this.serial++;
    this.status = 'unsaved';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 300);
    this.maxTimer ??= setTimeout(() => { void this.flush().catch(() => {}); }, 2000);
    this.notify();
  };

  private current() {
    if (!this.controller) return structuredClone(this.active);
    const scene = this.controller.capture();
    return { ...this.active, revision: this.controller.revision, scene };
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer); clearTimeout(this.maxTimer); this.maxTimer = undefined;
    if (this.saving) return this.saving;
    this.saving = this.saveLoop().finally(() => { this.saving = undefined; });
    return this.saving;
  }

  private async saveLoop() {
    try {
      while (this.savedSerial !== this.serial) {
        const captured = this.current();
        const serial = this.serial;
        this.status = 'saving'; this.notify();
        captured.updatedAt = new Date().toISOString();
        const version = await this.storage.save(captured, this.active.storageVersion);
        this.active.storageVersion = version;
        this.active.storageSize = captured.storageSize;
        this.active.updatedAt = captured.updatedAt;
        this.active.scene = captured.scene;
        this.savedSerial = serial;
      }
      this.status = 'saved'; this.error = '';
      await this.refresh();
    } catch (error) {
      const failure = storageError(error);
      this.status = 'error'; this.error = failure.message; this.notify(); throw failure;
    }
  }

  private async refresh() { this.documents = (await this.storage.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); this.notify(); }
  private async get(id: string) { return id === this.active.id ? this.current() : this.storage.get(id); }
  private checkRevision(meta: DiagramMeta, revision: number) {
    if (meta.revision !== revision) throw new CommandError('revision_conflict', 'The diagram changed. Read its latest revision and replan.');
  }
  private async switchTo(diagram: Diagram) {
    await this.storage.setActive(diagram.id);
    this.active = diagram; this.serial = this.savedSerial = 0;
    this.controller?.dispose(); this.controller = undefined;
    // A fresh editor also releases its image cache; resetScene alone retains files.
    this.editorEpoch++;
    const ready = new Promise<void>((resolve, reject) => { this.editorReady = { resolve, reject }; });
    this.notify();
    await ready;
  }

  execute(command: Command): Promise<unknown> {
    const execute = async () => {
      if (Date.now() > command.deadline) throw new CommandError('expired_request', 'Request expired. Inspect the library before retrying.');
      validateArguments(command.tool, command.arguments);
      if (!this.controller) throw new CommandError('editor_loading', 'The editor is still loading.');
      const tool = command.tool;
      if (tool === 'get_diagram') return { ...this.controller.snapshot(), name: this.active.name, saveStatus: this.status };
      if (tool === 'fit_canvas') return this.controller.fit(command.arguments as ViewArguments);
      if (tool === 'preview_diagram') return this.controller.preview(command.arguments as ViewArguments);
      if (tool === 'apply_operations') {
        const args = command.arguments as ApplyArguments;
        if (args.diagramId !== this.active.id) throw new CommandError('diagram_changed', 'Read the active diagram before editing.');
        const fingerprint = args.requestId ? await operationFingerprint(args) : undefined;
        const previous = args.requestId && this.active.operationReceipts?.find(receipt => receipt.id === args.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new CommandError('request_id_conflict', 'This requestId was already used with different arguments. Use a new ID for a new edit.');
          await this.flush().catch(() => {});
          return { ...this.controller.snapshot(), name: this.active.name, saveStatus: this.status, saveError: this.error || undefined,
            replayed: true, appliedRevision: previous.revision, copies: previous.copies };
        }
        const result = this.controller.execute(command, id => this.customShapes.resolve(id));
        if (args.requestId) {
          this.active.operationReceipts = [...(this.active.operationReceipts ?? []), { id: args.requestId, fingerprint: fingerprint!, revision: result.revision, copies: result.copies ?? [] }].slice(-128);
          this.changed();
        }
        // Receipts and scene data are saved in the same IndexedDB transaction.
        // A storage failure does not undo the successful canvas edit. Report
        // its save status so agents can rescue it instead of applying it again.
        await this.flush().catch(() => {});
        return { ...this.controller.snapshot(), copies: result.copies, name: this.active.name, saveStatus: this.status,
          saveError: this.error || undefined, replayed: false, appliedRevision: result.revision };
      }
      const mutating = ['create_diagram', 'open_diagram', 'manage_diagram', 'delete_diagrams', 'import_diagram', 'import_library'].includes(tool);
      if (mutating) { this.controller.assertIdle(); this.busy = true; this.notify(); }
      try { return await this.perform(tool, command.arguments as Record<string, any>, command.deadline); }
      finally { if (mutating) { this.busy = false; this.notify(); } }
    };
    return this.enqueue(execute);
  }

  private enqueue<T>(execute: () => Promise<T>): Promise<T> {
    const result = this.queue.then(execute);
    this.queue = result.catch(() => {});
    return result;
  }

  onCustomShapesChange(items: LibraryItems) {
    // updateLibrary also emits onLibraryChange. Our correction is already in
    // storage; feeding it back through restore/validation can cause an endless
    // series of native updates (including harmless property-order differences).
    if (this.syncingCustomShapes) return Promise.resolve();
    return this.acceptCustomShapes(items);
  }

  private async acceptCustomShapes(items: LibraryItems) {
    try { await this.customShapes.accept(items); }
    finally {
      // Native file imports need the same repaired templates as catalog imports
      // and agents. Also restore the last accepted library after invalid input.
      if (!this.syncingCustomShapes && JSON.stringify(items) !== JSON.stringify(this.customShapes.items)) {
        this.syncingCustomShapes = true;
        try { await this.editorAPI?.updateLibrary({ libraryItems: this.customShapes.items }); }
        finally { this.syncingCustomShapes = false; }
      }
    }
  }

  importCustomShapes(items: LibraryItems) {
    return this.enqueue(async () => {
      if (!this.editorAPI) throw new CommandError('editor_loading', 'Wait for the canvas to finish loading, then retry.');
      const previous = this.customShapes.items.length;
      // Restoring older files can regenerate item IDs and element version
      // nonces. Match actual template content so reinstalling is still a no-op.
      const contentKey = (item: LibraryItems[number]) => canonical(item.elements.map(({ index: _index, version: _version, versionNonce: _nonce, updated: _updated, ...element }) => element));
      const installedIDs = new Set(this.customShapes.items.map(item => item.id));
      const installedContent = new Set(this.customShapes.items.map(contentKey));
      const additions = items.filter(item => {
        const key = contentKey(item);
        if (installedIDs.has(item.id) || installedContent.has(key)) return false;
        installedIDs.add(item.id); installedContent.add(key); return true;
      });
      const merged = await this.editorAPI.updateLibrary({ libraryItems: additions, merge: true, openLibraryMenu: true });
      await this.acceptCustomShapes(merged);
      return { added: Math.max(0, merged.length - previous), total: merged.length };
    });
  }

  run(tool: string, args: Record<string, unknown> = {}) {
    return this.execute({ type: 'command', id: crypto.randomUUID(), tool, arguments: args, deadline: Date.now() + 30_000 });
  }

  private async perform(tool: string, args: Record<string, any>, deadline: number): Promise<unknown> {
    if (tool === 'list_custom_shapes') return this.customShapes.list(args.query, args.offset, args.limit);
    if (tool === 'list_diagrams') {
      await this.flush().catch(() => {});
      return { activeDiagramId: this.active.id, activeRevision: this.controller!.revision, saveStatus: this.status, saveError: this.error || undefined,
        diagrams: this.documents.filter((item) => args.includeTrash || !item.deletedAt).map(({ storageVersion: _version, operationReceipts: _receipts, ...meta }) => meta) };
    }
    if (tool === 'delete_diagrams') {
      const targets = args.diagrams as DeleteDiagramTarget[];
      if (targets.some(item => item.diagramId === this.active.id)) throw new CommandError('diagram_not_trashed', 'Only diagrams in the trash can be permanently deleted.');
      // Freeing space must work even when unsaved canvas edits exceed quota.
      // This only touches trash; it never switches or saves the active canvas.
      await this.storage.deleteTrashed(targets, deadline);
      await this.refresh();
      return { deletedIds: targets.map(item => item.diagramId), count: targets.length };
    }
    if (tool === 'release_transfer') { this.transfers.finish(args.transferId); return { released: true }; }
    if (tool === 'read_export') return this.transfers.read(args.artifactId, args.offset ?? 0, args.length ?? 16_000);
    if (tool === 'begin_import') return this.transfers.begin(args.kind);
    if (tool === 'write_import_chunk') return this.transfers.append(args.uploadId, args.offset, args.data);
    // Exports also work when saving has failed, so a user can rescue the live canvas.
    if (tool === 'export_diagram') {
      const diagram = await this.get(args.diagramId);
      return { diagramId: diagram.id, revision: diagram.revision, ...this.transfers.export(await exportDiagram(diagram, args.format ?? 'excalidraw')) };
    }
    if (tool === 'export_library') {
      const metas = await this.storage.list();
      const included = metas.filter((meta) => args.includeTrash !== false || !meta.deletedAt);
      if (included.length > 100) throw new CommandError('library_too_large', 'Library backups support up to 100 diagrams. Export individual diagrams or omit trash.');
      const diagrams = await Promise.all(included.map(async (meta) => {
        const item = await this.get(meta.id);
        return { id: item.id, name: item.name, deletedAt: item.deletedAt, document: sceneFile(item.scene) };
      }));
      const data = JSON.stringify({ type: 'diagrams-library', version: 1, exportedAt: new Date().toISOString(), diagrams });
      if (byteLength(data) > MAX_LIBRARY_BYTES) throw new CommandError('library_too_large', 'This library exceeds the 64 MB backup limit. Export individual diagrams.');
      return this.transfers.export({ filename: 'diagrams-library.json', mimeType: 'application/json', encoding: 'utf8', data });
    }
    let imported: Scene | undefined;
    let library: Diagram[] | undefined;
    let importedIds: string[] = [];
    if (tool === 'import_diagram') imported = parseScene(parseJSON(this.transfers.input(args, 'diagram')));
    if (tool === 'import_library') {
      const data = parseJSON(this.transfers.input(args, 'library'), MAX_LIBRARY_BYTES) as any;
      if (!data || data.type !== 'diagrams-library' || data.version !== 1 || !Array.isArray(data.diagrams) || !data.diagrams.length || data.diagrams.length > 100) throw new CommandError('invalid_import', 'Choose a version 1 diagram library containing 1–100 diagrams.');
      const ids = new Set<string>();
      library = data.diagrams.map((item: any) => {
        if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw new CommandError('invalid_import', 'Library diagram IDs must be unique.');
        ids.add(item.id); importedIds.push(item.id);
        if (byteLength(JSON.stringify(item.document)) > MAX_DOCUMENT_BYTES) throw new CommandError('invalid_import', 'A library diagram exceeds 16 MB.');
        const result = makeDiagram(diagramName(item.name), parseScene(item.document));
        if (item.deletedAt != null) {
          if (typeof item.deletedAt !== 'string' || !Number.isFinite(Date.parse(item.deletedAt))) throw new CommandError('invalid_import', 'Invalid trash date.');
          result.deletedAt = item.deletedAt;
        }
        return result;
      });
    }
    await this.flush();
    if (Date.now() > deadline) throw new CommandError('expired_request', 'Request expired before changing the library.');
    if (tool === 'create_diagram') {
      const diagram = makeDiagram(diagramName(args.name));
      await this.storage.insert([diagram]); await this.refresh();
      return metadata(diagram);
    }
    if (tool === 'open_diagram') {
      if (args.expectedActiveDiagramId !== this.active.id) throw new CommandError('diagram_changed', 'The active diagram changed. List diagrams again.');
      this.checkRevision(this.active, args.expectedActiveRevision);
      const diagram = await this.get(args.diagramId);
      if (diagram.deletedAt) throw new CommandError('diagram_trashed', 'Restore this diagram before opening it.');
      await this.switchTo(diagram);
      return { ...this.controller!.snapshot(), name: diagram.name, saveStatus: this.status };
    }
    if (tool === 'manage_diagram') {
      const meta = this.documents.find((item) => item.id === args.diagramId);
      if (!meta) throw new CommandError('diagram_not_found', 'Diagram not found.');
      this.checkRevision(args.diagramId === this.active.id ? this.active : meta, args.expectedRevision);
      const diagram = args.action === 'recover' ? { ...meta, scene: await this.storage.previous(meta.id) } : await this.get(meta.id);
      if (args.action === 'duplicate') {
        const copy = makeDiagram(diagramName(args.name, `${diagram.name.slice(0,110)} copy`), diagram.scene);
        await this.storage.insert([copy]); await this.refresh(); return metadata(copy);
      }
      if (args.action === 'rename') diagram.name = diagramName(args.name);
      if (args.action === 'trash') diagram.deletedAt = new Date().toISOString();
      if (args.action === 'restore') diagram.deletedAt = null;
      diagram.revision++; diagram.updatedAt = new Date().toISOString();
      diagram.storageVersion = await this.storage.save(diagram, meta.storageVersion, false);
      if (diagram.id === this.active.id) {
        if (diagram.deletedAt) {
          await this.refresh();
          const next = this.documents.find((item) => !item.deletedAt);
          let nextDiagram: Diagram;
          if (next) nextDiagram = await this.storage.get(next.id);
          else { nextDiagram = makeDiagram('Untitled diagram'); await this.storage.insert([nextDiagram]); }
          await this.switchTo(nextDiagram);
        } else if (args.action === 'recover') await this.switchTo(diagram);
        else { this.active = diagram; this.controller!.revision = diagram.revision; }
      }
      await this.refresh(); return metadata(diagram);
    }
    if (tool === 'import_diagram') {
      let diagram: Diagram;
      if (args.replaceDiagramId) {
        diagram = await this.get(args.replaceDiagramId);
        this.checkRevision(diagram, args.expectedRevision);
        if (diagram.deletedAt) throw new CommandError('diagram_trashed', 'Restore this diagram before replacing it.');
        diagram = { ...diagram, name: diagramName(args.name, diagram.name), scene: imported!, revision: diagram.revision + 1, updatedAt: new Date().toISOString() };
        diagram.storageVersion = await this.storage.save(diagram, diagram.storageVersion);
        if (diagram.id === this.active.id) await this.switchTo(diagram);
      } else { diagram = makeDiagram(diagramName(args.name, 'Imported diagram'), imported); await this.storage.insert([diagram]); }
      this.transfers.finish(args.uploadId); await this.refresh(); return metadata(diagram);
    }
    if (tool === 'import_library') {
      await this.storage.insert(library!);
      this.transfers.finish(args.uploadId); await this.refresh();
      return { imported: library!.map((diagram, index) => ({ sourceId: importedIds[index], ...metadata(diagram) })) };
    }
    throw new CommandError('unknown_tool', `Unknown tool: ${tool}`);
  }

  async retrySave() { await this.flush(); }
  dismissError() { this.error = ''; this.notify(); }
  dispose() { clearTimeout(this.timer); clearTimeout(this.maxTimer); this.controller?.dispose(); this.storage.close(); this.transfers.dispose(); this.release(); }
}

let opening: Promise<Workspace> | undefined;
export function openWorkspace() { return opening ??= Workspace.open().catch((error) => { opening = undefined; throw error; }); }
if (import.meta.hot) import.meta.hot.dispose(() => { void opening?.then((workspace) => workspace.dispose()); });
