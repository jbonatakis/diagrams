import { convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import { CommandError, type CreateFrameOperation, type UpdateFrameOperation } from '../protocol';
import { bounds, editable, isFrame, isFrameBackground, newID, required, withFrameContents, withGroups, type Element } from './elements';

export function canvasColor(color: string) {
  if (!/^(transparent|#[0-9a-fA-F]{6})$/.test(color)) {
    throw new CommandError('invalid_color', 'Use a six-digit hex color, such as #e1e8e5, or transparent.');
  }
  return color;
}

function fitted(elements: Element[], members: Element[], padding: number) {
  if (!members.length) throw new CommandError('empty_frame', 'Add content before fitting a frame.');
  const [x, y, right, bottom] = bounds(elements, members);
  return { x: x - padding, y: y - padding, width: Math.max(1, right - x + padding * 2), height: Math.max(1, bottom - y + padding * 2) };
}

function frameElement(elements: Element[], id: string) {
  const frame = required(elements, id);
  if (!isFrame(frame)) throw new CommandError('not_a_frame', id + ' is not a frame.');
  editable(frame);
  withFrameContents(elements, [id]);
  return frame;
}

function background(elements: Element[], frame: Element, color: string | null) {
  const existing = elements.filter(e => !e.isDeleted && e.frameId === frame.id && isFrameBackground(e));
  if (color === null) return elements.map(e => existing.includes(e) ? newElementWith(e, { isDeleted: true }) : e);
  canvasColor(color);
  const geometry = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  if (existing.length) return elements.map(e => existing.includes(e) ? newElementWith(e, { ...geometry, backgroundColor: color }) : e);
  const id = crypto.randomUUID(); newID(elements, id);
  const [rectangle] = convertToExcalidrawElements([{ type: 'rectangle', id, ...geometry,
    backgroundColor: color, fillStyle: 'solid', strokeColor: 'transparent', roughness: 0,
    locked: true, frameId: frame.id, customData: { diagramsFrameBackground: true },
  }], { regenerateIds: false });
  const at = elements.findIndex(e => !e.isDeleted && (e.frameId === frame.id || e.id === frame.id));
  return [...elements.slice(0, at), newElementWith<Element>(rectangle, { index: null }), ...elements.slice(at)];
}

export function createFrame(elements: Element[], op: CreateFrameOperation) {
  newID(elements, op.id);
  for (const id of op.ids) editable(required(elements, id));
  let selected = withGroups(elements, op.ids);
  // Include connectors whose two endpoints are inside the new frame.
  for (const e of elements) if (!e.isDeleted && e.type === 'arrow' && e.startBinding && e.endBinding
    && selected.has(e.startBinding.elementId) && selected.has(e.endBinding.elementId)) selected.add(e.id);
  selected = withGroups(elements, [...selected]);
  const members = elements.filter(e => !e.isDeleted && selected.has(e.id));
  for (const e of members) {
    if (isFrame(e) || e.frameId) throw new CommandError('nested_frame', 'Frames cannot be nested. Remove the existing frame first, keeping its contents.');
    if (e.locked) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before framing it.');
  }
  const [created] = convertToExcalidrawElements([{ type: 'frame', id: op.id, children: [], name: op.name }], { regenerateIds: false });
  const frame = newElementWith<Element>(created, { ...fitted(elements, members, op.padding ?? 40), index: null });
  // Gather members at the frontmost member's old position, children before frame.
  const last = elements.reduce((last, e, i) => selected.has(e.id) ? i : last, -1);
  const content = members.map(e => newElementWith(e, { frameId: frame.id, index: null }));
  let result = [...elements.slice(0, last + 1).filter(e => !selected.has(e.id)), ...content,
    frame, ...elements.slice(last + 1)];
  if (op.background !== undefined) result = background(result, frame, op.background);
  return result;
}

export function updateFrame(elements: Element[], op: UpdateFrameOperation) {
  const original = frameElement(elements, op.id);
  const members = elements.filter(e => !e.isDeleted && e.frameId === op.id && !isFrameBackground(e));
  const frame = newElementWith(original, {
    ...(op.name === undefined ? {} : { name: op.name }),
    ...(op.padding === undefined ? {} : fitted(elements, members, op.padding)),
  });
  let result = elements.map(e => e.id === frame.id ? frame : e);
  if (op.background !== undefined) result = background(result, frame, op.background);
  else if (op.padding !== undefined) result = result.map(e => !e.isDeleted && e.frameId === frame.id && isFrameBackground(e)
    ? newElementWith(e, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }) : e);
  return result;
}

export function removeFrame(elements: Element[], id: string) {
  frameElement(elements, id);
  for (const e of elements) if (!e.isDeleted && e.frameId === id && e.locked && !isFrameBackground(e)) {
    throw new CommandError('element_locked', 'Unlock ' + e.id + ' before removing its frame.');
  }
  return elements.map(e => e.isDeleted ? e : e.id === id || (e.frameId === id && isFrameBackground(e))
    ? newElementWith(e, { isDeleted: true })
    : e.frameId === id ? newElementWith(e, { frameId: null }) : e);
}
