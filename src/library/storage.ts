import { CommandError, type DeleteDiagramTarget } from '../protocol';
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import { byteLength, MAX_DOCUMENT_BYTES, parseScene, sceneFile, type Diagram, type DiagramMeta, type Scene, type StorageSize } from './scene';

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed.')); });
const jsonBytes = (value: unknown) => value === undefined ? 0 : byteLength(JSON.stringify(value));
// Estimate the data itself; omit the size-accounting fields and database overhead.
const metadataBytes = ({ storageSize: _size, ...meta }: DiagramMeta) => jsonBytes(meta);
function sceneRecord(scene: Scene) {
  const raw = sceneFile(scene);
  const sceneBytes = jsonBytes(raw);
  if (sceneBytes > MAX_DOCUMENT_BYTES) throw new CommandError('document_too_large', 'This diagram exceeds the 16 MB save limit. Export it and reduce its image sizes.');
  parseScene(raw);
  return { raw, sceneBytes };
}
export const storageError = (error: unknown) => error instanceof CommandError ? error : new CommandError('storage_error', error instanceof DOMException && error.name === 'QuotaExceededError'
  ? 'Browser storage is full. Your canvas is still open; export a backup, free space, then retry saving.'
  : 'Could not save to this browser. Your canvas is still open. Export a backup and retry saving.');

export class DiagramStorage {
  private measured = new Map<string, { version: number; size: StorageSize }>();
  private constructor(private db: IDBDatabase) {}

  static open() {
    return new Promise<DiagramStorage>((resolve, reject) => {
      const open = indexedDB.open('diagrams', 1);
      open.onupgradeneeded = () => { for (const store of ['diagrams', 'scenes', 'recovery', 'settings']) open.result.createObjectStore(store); };
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Close other diagram tabs to finish the storage upgrade.'));
      open.onsuccess = () => { open.result.onversionchange = () => open.result.close(); resolve(new DiagramStorage(open.result)); };
    });
  }

  async list(): Promise<DiagramMeta[]> {
    const metas: DiagramMeta[] = await request(this.db.transaction('diagrams').objectStore('diagrams').getAll());
    // Older diagrams are measured once per session, one at a time to avoid
    // loading the whole library's scenes into memory. Their next save persists
    // the counts; listing alone never needs to write to a potentially full DB.
    for (const meta of metas) {
      if (meta.storageSize) continue;
      let cached = this.measured.get(meta.id);
      if (cached?.version !== meta.storageVersion) {
        const tx = this.db.transaction(['scenes', 'recovery']);
        const [scene, recovery] = await Promise.all([request(tx.objectStore('scenes').get(meta.id)), request(tx.objectStore('recovery').get(meta.id))]);
        cached = { version: meta.storageVersion, size: { sceneBytes: jsonBytes(scene), recoveryBytes: jsonBytes(recovery), metadataBytes: metadataBytes(meta) } };
        this.measured.set(meta.id, cached);
      }
      meta.storageSize = cached!.size;
    }
    return metas;
  }

  async get(id: string): Promise<Diagram> {
    const tx = this.db.transaction(['diagrams', 'scenes']);
    const [meta, raw] = await Promise.all([request(tx.objectStore('diagrams').get(id)), request(tx.objectStore('scenes').get(id))]);
    if (!meta) throw new CommandError('diagram_not_found', 'This diagram no longer exists. Refresh the library.');
    try { return { ...meta, scene: parseScene(raw) }; }
    catch { throw new CommandError('corrupt_diagram', 'This saved diagram could not be read. Use Recover previous save in the library, or import a backup.'); }
  }

  async previous(id: string): Promise<Scene> {
    const raw = await request(this.db.transaction('recovery').objectStore('recovery').get(id));
    if (!raw) throw new CommandError('no_recovery', 'There is no earlier saved version for this diagram.');
    return parseScene(raw);
  }

  async save(diagram: Diagram, expectedVersion: number, recovery = true) {
    const { raw, sceneBytes } = sceneRecord(diagram.scene);
    const tx = this.db.transaction(['diagrams', 'scenes', 'recovery'], 'readwrite');
    const done = completed(tx);
    const { scene, ...meta } = diagram;
    const next = { ...meta, storageVersion: expectedVersion + 1 };
    let size: StorageSize;
    let failure: unknown;
    const get = tx.objectStore('diagrams').get(meta.id);
    get.onsuccess = () => {
      const previous = get.result as DiagramMeta | undefined;
      if ((previous?.storageVersion ?? 0) !== expectedVersion) {
        failure = new CommandError('storage_conflict', 'Another tab changed this diagram. Export your current canvas before reloading.');
        tx.abort(); return;
      }
      try {
        const write = (recoveryBytes: number) => {
          size = { sceneBytes, recoveryBytes, metadataBytes: metadataBytes(next) };
          tx.objectStore('diagrams').put({ ...next, storageSize: size }, meta.id);
          tx.objectStore('scenes').put(raw, meta.id);
        };
        const keepRecovery = () => {
          if (previous?.storageSize) { write(previous.storageSize.recoveryBytes); return; }
          const oldRecovery = tx.objectStore('recovery').get(meta.id);
          oldRecovery.onsuccess = () => {
            try { write(jsonBytes(oldRecovery.result)); }
            catch (error) { failure = error; tx.abort(); }
          };
        };
        if (recovery && previous && previous.revision !== meta.revision) {
          const oldScene = tx.objectStore('scenes').get(meta.id);
          oldScene.onsuccess = () => {
            try {
              if (oldScene.result) {
                tx.objectStore('recovery').put(oldScene.result, meta.id);
                write(jsonBytes(oldScene.result));
              } else keepRecovery();
            }
            catch (error) { failure = error; tx.abort(); }
          };
        } else keepRecovery();
      } catch (error) { failure = error; tx.abort(); }
    };
    try { await done; } catch (error) { throw storageError(failure ?? error); }
    diagram.storageSize = size!;
    this.measured.delete(meta.id);
    return expectedVersion + 1;
  }

  async insert(diagrams: Diagram[]) {
    const records = diagrams.map(({ scene, ...meta }) => {
      const { raw, sceneBytes } = sceneRecord(scene);
      const next = { ...meta, storageVersion: 1 };
      return { meta: { ...next, storageSize: { sceneBytes, recoveryBytes: 0, metadataBytes: metadataBytes(next) } }, raw };
    });
    const tx = this.db.transaction(['diagrams', 'scenes'], 'readwrite');
    const done = completed(tx);
    let failure: unknown;
    try {
      for (const { meta, raw } of records) {
        tx.objectStore('diagrams').add({ ...meta, storageVersion: 1 }, meta.id);
        tx.objectStore('scenes').add(raw, meta.id);
      }
    } catch (error) { failure = error; tx.abort(); }
    try { await done; } catch (error) { throw storageError(failure ?? error); }
    records.forEach(({ meta }, index) => { diagrams[index].storageSize = meta.storageSize; });
  }

  async activeId(): Promise<string | undefined> { return request(this.db.transaction('settings').objectStore('settings').get('active')); }
  async deleteTrashed(targets: DeleteDiagramTarget[], deadline: number) {
    if (!targets.length || new Set(targets.map(item => item.diagramId)).size !== targets.length) {
      throw new CommandError('invalid_arguments', 'Choose one or more different diagrams to delete.');
    }
    const tx = this.db.transaction(['diagrams', 'scenes', 'recovery', 'settings'], 'readwrite');
    const done = completed(tx);
    let failure: unknown;
    let remaining = targets.length + 1;
    let activeId: string | undefined;
    const records = new Map<string, DiagramMeta | undefined>();
    const remove = () => {
      if (--remaining) return;
      try {
        if (Date.now() > deadline) throw new CommandError('expired_request', 'The deletion request expired. Nothing was removed. Inspect the library before trying again.');
        // Validate every target in the same transaction before deleting any.
        for (const target of targets) {
          const meta = records.get(target.diagramId);
          if (!meta) throw new CommandError('diagram_not_found', 'A diagram no longer exists. Refresh the library and try again.');
          if (!meta.deletedAt || meta.id === activeId) throw new CommandError('diagram_not_trashed', 'Only diagrams in the trash can be permanently deleted.');
          if (meta.revision !== target.expectedRevision) throw new CommandError('revision_conflict', 'A trashed diagram changed. Close this confirmation and try again.');
        }
        for (const { diagramId } of targets) {
          for (const store of ['diagrams', 'scenes', 'recovery']) tx.objectStore(store).delete(diagramId);
        }
      } catch (error) { failure = error; tx.abort(); }
    };
    const active = tx.objectStore('settings').get('active');
    active.onsuccess = () => { activeId = active.result; remove(); };
    for (const { diagramId } of targets) {
      const meta = tx.objectStore('diagrams').get(diagramId);
      meta.onsuccess = () => { records.set(diagramId, meta.result); remove(); };
    }
    try { await done; }
    catch (error) { throw failure instanceof CommandError ? failure : new CommandError('storage_error', 'Could not delete diagrams. Nothing was removed. Try again.'); }
    for (const { diagramId } of targets) this.measured.delete(diagramId);
  }

  async setActive(id: string) {
    const tx = this.db.transaction('settings', 'readwrite'); const done = completed(tx);
    tx.objectStore('settings').put(id, 'active'); await done;
  }
  async getCustomShapes(): Promise<LibraryItems | undefined> {
    return request(this.db.transaction('settings').objectStore('settings').get('customShapes'));
  }
  async setCustomShapes(items: LibraryItems) {
    const tx = this.db.transaction('settings', 'readwrite'); const done = completed(tx);
    tx.objectStore('settings').put(items, 'customShapes'); await done;
  }
  close() { this.db.close(); }
}
