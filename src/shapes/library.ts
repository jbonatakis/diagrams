import { exportToCanvas, getCommonBounds, loadLibraryFromBlob } from '@excalidraw/excalidraw';
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import type { PointBinding } from '@excalidraw/excalidraw/element/types';
import { CommandError, type CustomShapePreviewArguments } from '../protocol';
import { encodePreview } from '../editor/preview';
import { byteLength, parseScene } from '../library/scene';
import type { DiagramStorage } from '../library/storage';

export const MAX_SHAPE_BYTES = 16 * 1024 * 1024;

// A saved selection can still refer to arrows, labels, or frames outside it.
// Those references have no meaning in a reusable template. Keep internal links
// and detach external ones before applying the stricter document validation.
function normalizeReferences(elements: LibraryItems[number]['elements']) {
  if (!Array.isArray(elements)) throw new CommandError('invalid_library', 'A custom shape must contain drawing elements.');
  const ids = new Set(elements.filter(element => element && !element.isDeleted).map(element => element.id));
  const reference = (id: string | null | undefined) => typeof id === 'string' && !ids.has(id) ? null : id;
  const binding = (value: PointBinding | null) => {
    if (!value || (typeof value.elementId === 'string' && !ids.has(value.elementId))) return null;
    // Older libraries contain focus values outside today's [-1, 1] range.
    // Preserve the connection and its drawn points, but normalize its anchor.
    return { ...value, focus: Number.isFinite(value.focus) ? Math.max(-1, Math.min(1, value.focus)) : value.focus };
  };
  return elements.map(element => {
    if (!element || typeof element !== 'object') return element;
    return { ...element,
      frameId: reference(element.frameId),
      boundElements: Array.isArray(element.boundElements) ? element.boundElements.filter((binding: { id: string }) => !binding || typeof binding.id !== 'string' || ids.has(binding.id)) : element.boundElements,
      ...(element.type === 'text' ? { containerId: reference(element.containerId) } : {}),
      ...(element.type === 'arrow' || element.type === 'line' ? {
        startBinding: binding(element.startBinding),
        endBinding: binding(element.endBinding),
      } : {}),
    };
  });
}

function validateItems(items: LibraryItems): LibraryItems {
  if (!Array.isArray(items) || items.length > 1000 || byteLength(JSON.stringify(items)) > MAX_SHAPE_BYTES) {
    throw new CommandError('shape_library_too_large', 'Custom Shapes supports up to 1,000 items and 16 MB.');
  }
  const ids = new Set<string>();
  let elementCount = 0;
  return items.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || ids.has(item.id)) throw new CommandError('invalid_library', 'Custom shape IDs must be unique.');
    ids.add(item.id);
    const scene = parseScene({ type: 'excalidraw', version: 2, elements: normalizeReferences(item.elements), files: {} });
    const elements = scene.elements.filter(element => !element.isDeleted);
    elementCount += elements.length;
    if (!elements.length || elementCount > 10_000 || elements.some(element => ['image', 'iframe', 'embeddable'].includes(element.type))) {
      throw new CommandError('invalid_library', 'Choose a library of drawing elements with at most 10,000 elements in total.');
    }
    return { ...item, elements } as LibraryItems[number];
  });
}

export async function parseShapeFile(file: Blob): Promise<LibraryItems> {
  if (file.size > MAX_SHAPE_BYTES) throw new CommandError('shape_library_too_large', 'Choose a shape library smaller than 16 MB.');
  const raw = JSON.parse(await file.text());
  if (raw?.type !== 'excalidrawlib' || ![1, 2].includes(raw.version)) throw new CommandError('invalid_library', 'Choose an .excalidrawlib shape library.');
  const items = validateItems(await loadLibraryFromBlob(file));
  if (!items.length) throw new CommandError('invalid_library', 'This shape library is empty.');
  return items;
}

export class CustomShapes {
  items: LibraryItems;
  private serial = 0;
  private savedSerial = 0;
  private saving?: Promise<void>;
  private error = '';
  private listeners = new Set<() => void>();
  private storageSize = { bytes: 0, items: [] as { id: string; status: LibraryItems[number]['status']; bytes: number }[] };
  private snapshot = { error: '', saving: false, dirty: false, count: 0, storageSize: this.storageSize };
  private fingerprint: string;

  private constructor(private storage: DiagramStorage, items: LibraryItems) {
    this.items = items;
    this.fingerprint = JSON.stringify(items);
    this.measureStorage();
    this.notify();
  }
  static async load(storage: DiagramStorage) {
    const saved = await storage.getCustomShapes();
    return new CustomShapes(storage, validateItems(saved ?? []));
  }
  get dirty() { return this.serial !== this.savedSerial; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private measureStorage() {
    // Count each template, including its metadata, once when the library changes.
    // As with diagram sizes, database keys and browser overhead are excluded.
    const items = this.items.map(item => ({ id: item.id, status: item.status, bytes: byteLength(JSON.stringify(item)) }));
    this.storageSize = { items, bytes: items.reduce((total, item) => total + item.bytes, 0) };
  }
  private notify() {
    this.snapshot = { error: this.error, saving: !!this.saving, dirty: this.dirty, count: this.items.length, storageSize: this.storageSize };
    for (const listener of this.listeners) listener();
  }
  async accept(items: LibraryItems) {
    const checked = validateItems(items);
    const fingerprint = JSON.stringify(checked);
    if (fingerprint !== this.fingerprint) {
      this.items = structuredClone(checked); this.fingerprint = fingerprint; this.serial++; this.measureStorage(); this.notify();
    }
    await this.flush();
  }
  flush(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.dirty) return Promise.resolve();
    this.saving = this.save().finally(() => { this.saving = undefined; this.notify(); });
    this.notify();
    return this.saving;
  }
  private async save() {
    try {
      while (this.dirty) {
        const serial = this.serial;
        await this.storage.setCustomShapes(this.items);
        this.savedSerial = serial;
      }
      this.error = '';
    } catch {
      this.error = 'Custom shapes could not be saved in this browser. Export them from Custom Shapes before reloading, or retry saving.';
      throw new CommandError('storage_error', this.error);
    }
  }
  list(query = '', offset = 0, limit = 50) {
    const all = this.items.map(item => {
      const [x1, y1, x2, y2] = getCommonBounds(item.elements);
      const text = item.elements.filter(element => element.type === 'text').map(element => element.originalText).join(' ').slice(0, 500);
      const name = typeof item.name === 'string' ? item.name.slice(0, 500) : undefined;
      const types = [...new Set(item.elements.map(element => element.type))];
      return { id: item.id, name, text, types, elementCount: item.elements.length, width: x2 - x1, height: y2 - y1 };
    }).filter(item => `${item.id} ${item.name ?? ''} ${item.text} ${item.types.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return { shapes: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null,
      saveStatus: this.dirty ? 'unsaved' : 'saved', saveError: this.error || undefined };
  }
  async preview(args: CustomShapePreviewArguments, deadline: number) {
    const page = this.list(args.query, args.offset, args.limit ?? 12);
    if (args.shapeIds) {
      const byId = new Map(this.list('', 0, this.items.length).shapes.map(shape => [shape.id, shape]));
      page.shapes = args.shapeIds.map(id => {
        const shape = byId.get(id);
        if (!shape) throw new CommandError('shape_not_found', 'Custom shape not found. Call list_custom_shapes again.');
        return shape;
      });
      page.total = page.shapes.length; page.nextOffset = null;
    }
    if (!page.shapes.length) throw new CommandError('no_custom_shapes', 'No custom shapes matched. Call list_custom_shapes to check installed shapes or try another query or offset.');
    // Capture independent copies before awaiting font loading/rendering. Never
    // insert into the editor or change the library to generate a preview.
    const sources = page.shapes.map(shape => structuredClone(this.resolve(shape.id)));
    const columns = Math.ceil(Math.sqrt(sources.length)), rows = Math.ceil(sources.length / columns);
    const cell = Math.floor((args.maxSize ?? 1200) / Math.max(columns, rows));
    const padding = Math.max(6, Math.round(cell * 0.04)), caption = Math.max(20, Math.round(cell * 0.1));
    const availableWidth = cell - padding * 2, availableHeight = cell - caption - padding * 2;
    const canvas = document.createElement('canvas');
    canvas.width = cell * columns; canvas.height = cell * rows;
    const context = canvas.getContext('2d');
    if (!context) throw new CommandError('preview_unavailable', 'This browser could not create a preview.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    for (const [index, elements] of sources.entries()) {
      if (Date.now() > deadline) throw new CommandError('expired_request', 'Preview expired. Request fewer custom shapes at once.');
      const thumbnail = await exportToCanvas({ elements, files: {}, exportPadding: 10,
        appState: { viewBackgroundColor: '#ffffff', exportBackground: true, exportWithDarkMode: false },
        getDimensions: (width: number, height: number) => {
          const scale = Math.min(availableWidth / width, availableHeight / height);
          return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
        } });
      const left = index % columns * cell, top = Math.floor(index / columns) * cell;
      const scale = Math.min(availableWidth / thumbnail.width, availableHeight / thumbnail.height);
      const width = thumbnail.width * scale, height = thumbnail.height * scale;
      context.drawImage(thumbnail, left + (cell - width) / 2, top + caption + padding + (availableHeight - height) / 2, width, height);
      context.strokeStyle = '#d9ded6'; context.strokeRect(left + 0.5, top + 0.5, cell - 1, cell - 1);
      context.fillStyle = '#333333'; context.font = `600 ${Math.max(14, Math.round(caption * 0.65))}px sans-serif`;
      context.textBaseline = 'top'; context.fillText(String(index + 1), left + padding, top + padding);
    }
    if (Date.now() > deadline) throw new CommandError('expired_request', 'Preview expired. Request fewer custom shapes at once.');
    return { ...page, shapes: page.shapes.map((shape, index) => ({ ...shape, number: index + 1 })),
      ...encodePreview(canvas) };
  }
  resolve(id: string) {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new CommandError('shape_not_found', 'Custom shape not found. Call list_custom_shapes again.');
    return item.elements;
  }
}
