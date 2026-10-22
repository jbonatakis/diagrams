import { convertToExcalidrawElements, getCommonBounds, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement, ExcalidrawArrowElement } from '@excalidraw/excalidraw/element/types';
import { CommandError, type Style, type TextStyle } from '../protocol';

export type Element = ExcalidrawElement;
export type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
export const isShape = (e: Element): e is Extract<Element, { type: 'rectangle' | 'ellipse' | 'diamond' }> => ['rectangle', 'ellipse', 'diamond'].includes(e.type);
export const isArrow = (e: Element): e is ExcalidrawArrowElement => e.type === 'arrow';
export const isLinear = (e: Element) => e.type === 'line' || e.type === 'arrow';
export const center = (e: Element): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];

export function required(elements: readonly Element[], id: string) {
  const e = elements.find(e => e.id === id && !e.isDeleted);
  if (!e) throw new CommandError('element_not_found', 'No live element has ID ' + id + '. Read get_diagram for current IDs.');
  return e;
}
export function editable(e: Element) {
  if (e.locked) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before editing it.');
  if (e.type === 'text' && e.containerId) throw new CommandError('bound_label', 'Edit the label through its container ' + e.containerId + '.');
}
export function newID(elements: readonly Element[], id: string) {
  if (elements.some(e => e.id === id)) throw new CommandError('duplicate_id', 'ID ' + id + ' already exists, including undo history. Use a new ID.');
}
export function style(value: Style): Partial<Element> {
  return Object.fromEntries(Object.entries({
    backgroundColor: value.fill, strokeColor: value.stroke, strokeStyle: value.strokeStyle,
    strokeWidth: value.strokeWidth, fillStyle: value.fillStyle, opacity: value.opacity, roughness: value.roughness,
  }).filter(([, value]) => value !== undefined)) as Partial<Element>;
}
export function bounds(elements: readonly Element[], targets = elements) {
  return getCommonBounds(targets, new Map(elements.map(e => [e.id, e])) as Parameters<typeof getCommonBounds>[1]);
}
export function withLabels(elements: readonly Element[], ids: readonly string[]) {
  const selected = new Set(ids);
  for (const id of ids) required(elements, id);
  for (const e of elements) if (!e.isDeleted && e.type === 'text' && e.containerId && selected.has(e.containerId)) selected.add(e.id);
  return selected;
}
export function selectedElements(elements: readonly Element[], ids?: readonly string[]) {
  if (!ids) return elements.filter(e => !e.isDeleted);
  const selected = withLabels(elements, ids);
  return elements.filter(e => !e.isDeleted && selected.has(e.id));
}
export function labelOf(elements: readonly Element[], id: string): ExcalidrawTextElement | undefined {
  return elements.find((e): e is ExcalidrawTextElement => !e.isDeleted && e.type === 'text' && e.containerId === id);
}

// The public skeleton API measures and wraps labels, including native arrow labels.
// Only newly constructed copies enter it, so a rejected batch never mutates the live scene.
export function reflowLabel(elements: Element[], id: string, text?: string, textStyle: TextStyle = {}): Element[] {
  const container = required(elements, id);
  const old = labelOf(elements, id);
  if (!old && !text) return elements;
  if (old?.locked) throw new CommandError('element_locked', 'Unlock the label on ' + id + ' first.');
  const content = text ?? old!.originalText;
  if (!content) return elements.map(e => e.id === old?.id ? newElementWith(e, { isDeleted: true })
    : e.id === id ? newElementWith(e, { boundElements: e.boundElements?.filter(b => b.type !== 'text') ?? [] }) : e);
  if (!isShape(container) && container.type !== 'arrow') throw new CommandError('unsupported_label', 'Labels belong to basic shapes or arrows. Use standalone text for other elements.');
  const labelID = old?.id ?? crypto.randomUUID();
  const fresh = convertToExcalidrawElements([{
    ...container, boundElements: container.boundElements?.filter(b => b.type !== 'text') ?? [],
    label: { ...old, id: labelID, text: content, originalText: content, fontFamily: old?.fontFamily ?? 2,
      fontSize: textStyle.fontSize ?? old?.fontSize ?? 20, textAlign: textStyle.textAlign ?? old?.textAlign ?? 'center',
      groupIds: container.groupIds, frameId: container.frameId, isDeleted: false },
  } as unknown as Skeleton], { regenerateIds: false });
  const nextContainer = fresh.find(e => e.id === id)!;
  const nextText = fresh.find(e => e.type === 'text' && e.id === labelID)!;
  // Skeleton arrow conversion nudges endpoints. Text-only edits must not change geometry.
  const updated = newElementWith(container, {
    ...(isShape(container) ? { width: nextContainer.width, height: nextContainer.height } : {}),
    boundElements: [...(container.boundElements?.filter(b => b.type !== 'text') ?? []), { type: 'text', id: labelID }],
  });
  let result = elements.map(e => e.id === id ? updated : e.id === old?.id ? newElementWith(e, nextText) : e);
  if (!old) result = [...result, nextText];
  return result;
}

export function measureText(element: ExcalidrawTextElement, text: string, changes: TextStyle & { width?: number } = {}): ExcalidrawTextElement {
  const { width, height: _height, ...rest } = element;
  const wrapped = changes.width !== undefined || !element.autoResize;
  const [created] = convertToExcalidrawElements([{
    ...rest, text, originalText: text, ...changes, autoResize: !wrapped,
    ...(wrapped ? { width: changes.width ?? width } : {}),
  }], { regenerateIds: false });
  const [measured] = restoreElements([{ ...created, x: element.x, y: element.y,
    ...(wrapped ? { width: changes.width ?? width } : {}) }], null, { repairBindings: true, refreshDimensions: true });
  if (measured?.type !== 'text') throw new CommandError('invalid_text', 'Could not measure text.');
  return newElementWith(element, { ...measured, x: element.x, y: element.y }) as ExcalidrawTextElement;
}

