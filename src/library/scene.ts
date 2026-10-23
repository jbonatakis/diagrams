import { exportToBlob, exportToSvg, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import { CommandError } from '../protocol';

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
export type Scene = { elements: ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles };
export type OperationReceipt = { id: string; fingerprint: string; revision: number; copies: { sourceId: string; id: string }[] };
export type StorageSize = { sceneBytes: number; recoveryBytes: number; metadataBytes: number };
export type DiagramMeta = { id: string; name: string; revision: number; storageVersion: number; createdAt: string; updatedAt: string; deletedAt: string | null; operationReceipts?: OperationReceipt[]; storageSize?: StorageSize };
export type Diagram = DiagramMeta & { scene: Scene };
export const emptyScene = (): Scene => ({ elements: [], files: {}, appState: { viewBackgroundColor: '#fcfcf9', scrollX: 0, scrollY: 0, zoom: { value: 1 as AppState['zoom']['value'] } } });
export const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const invalid = (message: string): never => { throw new CommandError('invalid_import', message); };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, max = 1_000_000): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
const types = new Set(['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'text', 'image', 'freedraw', 'frame', 'magicframe', 'iframe', 'embeddable']);

export function diagramName(value: unknown, fallback = 'Untitled diagram') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) invalid('Diagram names must contain 1–120 characters.');
  return (value as string).trim();
}

export function savedAppState(state: Partial<AppState>): Partial<AppState> {
  return {
    viewBackgroundColor: typeof state.viewBackgroundColor === 'string' && CSS.supports('color', state.viewBackgroundColor) ? state.viewBackgroundColor : '#fcfcf9',
    scrollX: finite(state.scrollX) ? state.scrollX : 0,
    scrollY: finite(state.scrollY) ? state.scrollY : 0,
    zoom: { value: (finite(state.zoom?.value, 30) && state.zoom!.value >= 0.1 ? state.zoom!.value : 1) as AppState['zoom']['value'] },
    gridModeEnabled: state.gridModeEnabled === true,
    gridSize: finite(state.gridSize, 1000) && state.gridSize > 0 ? state.gridSize : 20,
  };
}

export function parseJSON(data: string, limit = MAX_DOCUMENT_BYTES): unknown {
  if (byteLength(data) > limit) invalid(`This file exceeds the ${limit / 1024 / 1024} MB limit.`);
  try { return JSON.parse(data); } catch { return invalid('The file is not valid JSON.'); }
}

export function parseScene(data: unknown): Scene {
  if (!object(data) || data.type !== 'excalidraw' || ![1, 2].includes(data.version)) invalid('Choose an editable .excalidraw file (version 1 or 2).');
  const input = data as Record<string, any>;
  if (!Array.isArray(input.elements) || input.elements.length > 10_000) invalid('A diagram must contain at most 10,000 elements.');
  const ids = new Set<string>();
  for (const item of input.elements) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 200 || ids.has(item.id) || !types.has(item.type)) invalid('The diagram contains an invalid or duplicate element.');
    ids.add(item.id);
    for (const key of ['x', 'y', 'width', 'height']) if (!finite(item[key])) invalid(`Invalid ${key} on element ${item.id}.`);
    if (item.width < 0 || item.height < 0 || (item.angle !== undefined && !finite(item.angle, 100))) invalid('Invalid element geometry.');
    if (['arrow', 'line', 'freedraw'].includes(item.type) && (!Array.isArray(item.points) || item.points.length > 100_000 || item.points.some((p: unknown) => !Array.isArray(p) || p.length !== 2 || !p.every((v) => finite(v))))) invalid('Invalid line points.');
    if (item.type === 'text' && (typeof item.text !== 'string' || item.text.length > 100_000)) invalid('Invalid text element.');
    if (item.boundElements != null && (!Array.isArray(item.boundElements) || item.boundElements.some((b: unknown) => !object(b) || typeof b.id !== 'string' || !['text', 'arrow'].includes(b.type)))) invalid('Invalid element bindings.');
  }
  for (const item of input.elements) {
    for (const id of [item.containerId, item.frameId, item.startBinding?.elementId, item.endBinding?.elementId, ...(item.boundElements ?? []).map((b: { id: string }) => b.id)]) {
      if (id != null && !ids.has(id)) invalid(`Element ${item.id} refers to a missing element.`);
    }
    for (const binding of [item.startBinding, item.endBinding]) {
      if (binding != null && (!object(binding) || !finite(binding.focus, 1) || !finite(binding.gap) || binding.gap < 0)) invalid('Invalid connector binding.');
    }
  }
  const files: BinaryFiles = Object.create(null);
  if (input.files !== undefined && !object(input.files)) invalid('Invalid image files.');
  for (const [id, file] of Object.entries(input.files ?? {})) {
    if (!object(file) || file.id !== id || typeof file.dataURL !== 'string' || !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(file.dataURL) || typeof file.mimeType !== 'string') invalid('Images must be embedded in the file.');
    files[id] = file as BinaryFiles[string];
  }
  for (const item of input.elements) if (item.type === 'image' && !item.isDeleted && (!item.fileId || !files[item.fileId])) invalid('An image is missing its embedded file.');
  try {
    return { elements: restoreElements(input.elements, null, { repairBindings: true }), appState: savedAppState(object(input.appState) ? input.appState : {}), files };
  } catch { return invalid('The editor could not restore this diagram.'); }
}

export function sceneFile(scene: Scene) {
  const result = JSON.parse(serializeAsJSON(scene.elements, scene.appState, scene.files, 'local'));
  // Preserve the viewport in our round trips as well as the native scene data.
  result.appState = { ...result.appState, ...savedAppState(scene.appState) };
  return result;
}

export async function exportDiagram(diagram: Diagram, format: 'excalidraw' | 'svg' | 'png') {
  const filename = `${diagram.name.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0,100) || 'diagram'}.${format}`;
  if (format === 'excalidraw') return { filename, mimeType: 'application/json', encoding: 'utf8' as const, data: JSON.stringify(sceneFile(diagram.scene)) };
  const elements = diagram.scene.elements.filter((item) => !item.isDeleted);
  if (!elements.length) throw new CommandError('empty_diagram', 'Add something to the diagram before exporting an image.');
  const options = { elements, files: diagram.scene.files, appState: { ...diagram.scene.appState, exportBackground: true, exportWithDarkMode: false } };
  if (format === 'svg') {
    const svg = await exportToSvg({ ...options, renderEmbeddables: false });
    return { filename, mimeType: 'image/svg+xml', encoding: 'utf8' as const, data: svg.outerHTML };
  }
  const blob = await exportToBlob({ ...options, mimeType: 'image/png', maxWidthOrHeight: 4096 });
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob);
  });
  return { filename, mimeType: 'image/png', encoding: 'base64' as const, data };
}

export function downloadFile(file: { filename: string; mimeType: string; encoding: 'utf8' | 'base64'; data: string }) {
  const bytes = file.encoding === 'base64' ? Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)) : file.data;
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
