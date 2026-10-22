import { CommandError } from '../protocol';
import { parseScene, sceneFile, type Diagram, type DiagramMeta, type Scene } from './scene';

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed.')); });
export const storageError = (error: unknown) => error instanceof CommandError ? error : new CommandError('storage_error', error instanceof DOMException && error.name === 'QuotaExceededError'
  ? 'Browser storage is full. Your canvas is still open; export a backup, free space, then retry saving.'
  : 'Could not save to this browser. Your canvas is still open. Export a backup and retry saving.');

export class DiagramStorage {
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
    return request(this.db.transaction('diagrams').objectStore('diagrams').getAll());
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
    const raw = sceneFile(diagram.scene);
    parseScene(raw);
    const tx = this.db.transaction(['diagrams', 'scenes', 'recovery'], 'readwrite');
    const done = completed(tx);
    const { scene, ...meta } = diagram;
    let failure: unknown;
    const get = tx.objectStore('diagrams').get(meta.id);
    get.onsuccess = () => {
      const previous = get.result as DiagramMeta | undefined;
      if ((previous?.storageVersion ?? 0) !== expectedVersion) {
        failure = new CommandError('storage_conflict', 'Another tab changed this diagram. Export your current canvas before reloading.');
        tx.abort(); return;
      }
      try {
        if (recovery && previous && previous.revision !== meta.revision) {
          const oldScene = tx.objectStore('scenes').get(meta.id);
          oldScene.onsuccess = () => {
            try { if (oldScene.result) tx.objectStore('recovery').put(oldScene.result, meta.id); }
            catch (error) { failure = error; tx.abort(); }
          };
        }
        tx.objectStore('diagrams').put({ ...meta, storageVersion: expectedVersion + 1 }, meta.id);
        tx.objectStore('scenes').put(raw, meta.id);
      } catch (error) { failure = error; tx.abort(); }
    };
    try { await done; } catch (error) { throw storageError(failure ?? error); }
    return expectedVersion + 1;
  }

  async insert(diagrams: Diagram[]) {
    const records = diagrams.map(({ scene, ...meta }) => { const raw = sceneFile(scene); parseScene(raw); return { meta, raw }; });
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
  }

  async activeId(): Promise<string | undefined> { return request(this.db.transaction('settings').objectStore('settings').get('active')); }
  async setActive(id: string) {
    const tx = this.db.transaction('settings', 'readwrite'); const done = completed(tx);
    tx.objectStore('settings').put(id, 'active'); await done;
  }
  close() { this.db.close(); }
}
