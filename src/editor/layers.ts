import { newElementWith } from '@excalidraw/excalidraw';
import { CommandError, type Operation } from '../protocol';
import { carriedBackground, editable, isFrame, isFrameBackground, required, withFrameContents, withGroups, type Element } from './elements';

function ordered(previous: Element[], next: Element[]) {
  // Let Excalidraw assign fractional indices to moved elements at commit. Keeping
  // their old indices would break native undo/redo's reconstruction of the order.
  return next.map((e, i) => previous[i]?.id === e.id ? e : newElementWith(e, { index: null }));
}

export function normalizeFrames(elements: Element[]) {
  // Imported scenes may contain unsupported nested frames. Do not normalize
  // those as flat blocks, which would discard descendants of a nested frame.
  if (elements.some(e => !e.isDeleted && isFrame(e) && e.frameId)) return elements;
  const frames = new Set(elements.filter(e => !e.isDeleted && isFrame(e)).map(e => e.id));
  const children = new Map<string, Element[]>();
  for (const e of elements) if (!e.isDeleted && e.frameId && frames.has(e.frameId)) {
    const members = children.get(e.frameId) ?? [];
    members.push(e); children.set(e.frameId, members);
  }
  const next: Element[] = [];
  for (const e of elements) {
    if (!e.isDeleted && e.frameId && frames.has(e.frameId)) continue;
    if (frames.has(e.id)) {
      const members = children.get(e.id) ?? [];
      next.push(...members.filter(isFrameBackground), ...members.filter(e => !isFrameBackground(e)));
    }
    next.push(e);
  }
  return ordered(elements, next);
}

export function reorder(elements: Element[], op: Extract<Operation, { op: 'reorder' }>) {
  for (const id of op.ids) editable(required(elements, id));
  elements = normalizeFrames(elements);
  let selected = withGroups(elements, op.ids);
  selected = withFrameContents(elements, [...selected]);
  const targets = elements.filter(e => !e.isDeleted && selected.has(e.id));
  for (const e of targets) if (e.locked && !carriedBackground(e, selected)) {
    throw new CommandError('element_locked', 'Unlock ' + e.id + ' before changing its layer.');
  }
  const scopes = new Set(targets.filter(e => !e.frameId || !selected.has(e.frameId)).map(e => e.frameId));
  if (scopes.size !== 1) throw new CommandError('mixed_frames', 'Reorder elements within one frame, or select whole frames to reorder them on the canvas.');
  const scope = [...scopes][0];
  const live = elements.filter(e => !e.isDeleted);
  const byId = new Map(live.map(e => [e.id, e]));
  const inScope = (e: Element) => scope ? e.frameId === scope && !isFrameBackground(e) : true;
  const unitKey = (e: Element) => {
    // At canvas level, a frame and all its children are a single stacking unit.
    if (!scope && e.frameId) e = required(elements, e.frameId);
    if (e.type === 'text' && e.containerId) e = byId.get(e.containerId) ?? e;
    return e.groupIds.length ? 'group:' + e.groupIds.at(-1) : 'element:' + e.id;
  };
  const units = new Map<string, Element[]>();
  for (const e of live.filter(inScope)) {
    const key = unitKey(e), unit = units.get(key) ?? [];
    unit.push(e); units.set(key, unit);
  }
  let keys = [...units.keys()];
  const chosen = new Set(targets.filter(inScope).map(unitKey));
  if (op.position === 'front') keys = [...keys.filter(k => !chosen.has(k)), ...keys.filter(k => chosen.has(k))];
  else if (op.position === 'back') keys = [...keys.filter(k => chosen.has(k)), ...keys.filter(k => !chosen.has(k))];
  else if (op.position === 'forward') {
    for (let i = keys.length - 2; i >= 0; i--) if (chosen.has(keys[i]) && !chosen.has(keys[i + 1])) [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]];
  } else {
    for (let i = 1; i < keys.length; i++) if (chosen.has(keys[i]) && !chosen.has(keys[i - 1])) [keys[i], keys[i - 1]] = [keys[i - 1], keys[i]];
  }
  const reordered = keys.flatMap(k => units.get(k)!);
  let cursor = 0;
  return ordered(elements, elements.map(e => !e.isDeleted && inScope(e) ? reordered[cursor++] : e));
}
