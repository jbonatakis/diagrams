import { convertToExcalidrawElements, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawArrowElement } from '@excalidraw/excalidraw/element/types';
import { CommandError, type ElementChanges, type Operation, type Point } from '../protocol';
import { bounds, carriedBackground, editable, isArrow, isFrame, isFrameBackground, isLinear, isShape, measureText, newID, reflowLabel, required, style, withFrameContents, withLabels, type Element, type Skeleton } from './elements';
import { asArrow, geometry, makeArrow, makeLine, repairReferences, routeArrow, setRouting, updateAttached } from './connectors';
import { canvasColor, createFrame, removeFrame, updateFrame } from './frames';
import { normalizeFrames, reorder } from './layers';

function replace(elements: Element[], element: Element) { return elements.map(e => e.id === element.id ? element : e); }
function roots(elements: Element[], ids: string[]) { return ids.map(id => { const e = required(elements, id); editable(e); return e; }); }

function translate(elements: Element[], ids: string[], dx: number, dy: number): Element[] {
  roots(elements, ids);
  const selected = withFrameContents(elements, ids);
  for (const e of elements) if (selected.has(e.id) && e.locked && !carriedBackground(e, selected)) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before moving it.');
  let result = elements.map(e => selected.has(e.id) ? newElementWith(e, { x: e.x + dx, y: e.y + dy }) : e);
  // Containers carry labels. Arrows selected with their shapes are translated
  // once, then their endpoint geometry is recomputed from the final shape positions.
  for (const e of result) if (selected.has(e.id) && isArrow(e)) {
    result = replace(result, routeArrow(result, e)); result = reflowLabel(result, e.id);
  }
  return updateAttached(result, selected, new Set(result.filter(e => selected.has(e.id) && isArrow(e)).map(e => e.id)));
}

function update(elements: Element[], id: string, changes: ElementChanges): Element[] {
  const original = required(elements, id); editable(original);
  if (isFrame(original)) throw new CommandError('unsupported_property', 'Use update_frame for frame name, padding, and background; use move or translate to move a frame and its contents.');
  const textKeys = ['text', 'fontSize', 'textAlign'].some(key => key in changes);
  const connectorKeys = ['fromId', 'toId', 'routing', 'startArrowhead', 'endArrowhead'].some(key => key in changes);
  if (connectorKeys && !isLinear(original)) throw new CommandError('unsupported_property', 'Endpoint bindings, routing, and markers require a line or arrow.');
  const markerKeys = changes.startArrowhead !== undefined || changes.endArrowhead !== undefined;
  const needsArrow = [changes.startArrowhead, changes.endArrowhead].some(head => head && head !== 'none')
    || changes.fromId != null || changes.toId != null || changes.routing === 'elbow';
  if (changes.points && !isLinear(original)) throw new CommandError('unsupported_property', 'Points can only be edited on lines and arrows.');
  if (textKeys && original.type !== 'text' && !isShape(original) && original.type !== 'arrow' && !(original.type === 'line' && needsArrow)) throw new CommandError('unsupported_property', 'Text styling requires standalone text or a shape/arrow label.');
  if (original.type === 'text' && changes.height !== undefined) throw new CommandError('unsupported_property', 'Text height is measured automatically; change fontSize, text, or width.');
  const geometryKeys = ['x', 'y', 'width', 'height', 'angle'].some(key => key in changes);
  if (geometryKeys && !isShape(original) && !isLinear(original) && original.type !== 'text' && original.type !== 'image') throw new CommandError('unsupported_geometry', 'Resize and rotation support basic shapes, text, lines, arrows, and images. Use translate to move other elements.');
  let next = newElementWith<Element>(original, { ...style(changes),
    ...(changes.x === undefined ? {} : { x: changes.x }), ...(changes.y === undefined ? {} : { y: changes.y }),
    ...(changes.width === undefined ? {} : { width: changes.width }), ...(changes.height === undefined ? {} : { height: changes.height }),
    ...(changes.angle === undefined ? {} : { angle: changes.angle as Element['angle'] }),
  });
  if (next.type === 'text') next = measureText(next, changes.text ?? next.originalText, changes);
  if (next.type === 'line' || next.type === 'arrow') {
    next = newElementWith(next, {
      ...(changes.startArrowhead === undefined ? {} : { startArrowhead: changes.startArrowhead === 'none' ? null : changes.startArrowhead }),
      ...(changes.endArrowhead === undefined ? {} : { endArrowhead: changes.endArrowhead === 'none' ? null : changes.endArrowhead }),
      ...(changes.fromId === null ? { startBinding: null } : {}), ...(changes.toId === null ? { endBinding: null } : {}),
    });
    if (changes.points && geometryKeys) throw new CommandError('conflicting_geometry', 'Set points or position/size/rotation in one operation, not both.');
    if (changes.points) next = newElementWith(next, geometry(changes.points));
    else if (changes.width !== undefined || changes.height !== undefined) {
      if ((!original.width && changes.width !== undefined) || (!original.height && changes.height !== undefined)) throw new CommandError('invalid_geometry', 'Use points to resize a line along an axis with zero extent.');
      const scaled = next.points.map(([x, y]) => [x * (changes.width === undefined ? 1 : changes.width / original.width), y * (changes.height === undefined ? 1 : changes.height / original.height)]) as typeof next.points;
      next = newElementWith(next, { points: scaled });
    }
    if (next.type === 'line' && needsArrow) next = asArrow(next);
    if (changes.routing !== undefined) next = setRouting(next, changes.routing);
    if (next.type === 'arrow') {
      const binding = (value: string | null | undefined, old: ExcalidrawArrowElement['startBinding']) => {
        if (value === undefined) return old;
        if (value === null) return null;
        const target = required(elements, value);
        if (!isShape(target)) throw new CommandError('unsupported_shape', 'Arrow endpoints must bind to a basic shape.');
        return { elementId: value, focus: 0, gap: 8 };
      };
      next = newElementWith(next, {
        startBinding: binding(changes.fromId, next.startBinding), endBinding: binding(changes.toId, next.endBinding),
      });
      if (changes.angle !== undefined && changes.angle !== 0) {
        if ((next as ExcalidrawArrowElement).elbowed) throw new CommandError('unsupported_rotation', 'Elbow arrows keep horizontal and vertical segments. Rotate their shapes instead.');
        if (next.startBinding || next.endBinding) throw new CommandError('unsupported_rotation', 'Detach bound arrow endpoints before rotating the arrow.');
      }
      if (geometryKeys || changes.points || changes.fromId !== undefined || changes.toId !== undefined || changes.routing !== undefined || markerKeys) {
        next = routeArrow(elements, next as ExcalidrawArrowElement, changes.fromId !== undefined || changes.toId !== undefined || changes.routing !== undefined);
      }
    }
  }
  let result = replace(elements, next);
  if (isShape(next) || next.type === 'arrow') result = reflowLabel(result, id, changes.text, changes);
  // Text labels may grow a container, so update attached arrows after measurement.
  if (geometryKeys || textKeys) result = updateAttached(result, new Set([id]));
  return repairReferences(result);
}

function remove(elements: Element[], ids: string[]) {
  roots(elements, ids);
  const selected = withFrameContents(elements, ids);
  for (const e of elements) if (!e.isDeleted && e.type === 'arrow' && [e.startBinding?.elementId, e.endBinding?.elementId].some(id => id && selected.has(id))) selected.add(e.id);
  const all = withLabels(elements, [...selected]);
  for (const e of elements) if (all.has(e.id) && e.locked && !carriedBackground(e, all)) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before deleting it.');
  return repairReferences(elements.map(e => all.has(e.id) ? newElementWith(e, { isDeleted: true }) : e));
}

function duplicate(elements: Element[], op: Extract<Operation, { op: 'duplicate' }>) {
  const selected = withFrameContents(elements, op.ids);
  for (const e of elements) if (!e.isDeleted && e.type === 'arrow' && e.startBinding && e.endBinding && selected.has(e.startBinding.elementId) && selected.has(e.endBinding.elementId)) selected.add(e.id);
  const all = withLabels(elements, [...selected]);
  const source = elements.filter(e => !e.isDeleted && all.has(e.id));
  return copyElements(elements, source, op.idPrefix, op.dx ?? 40, op.dy ?? 40);
}

function copyElements(elements: Element[], source: readonly Element[], idPrefix: string, dx: number, dy: number, groupInstance = false) {
  const mapping = new Map(source.map((e, index) => [e.id, idPrefix + '-' + (index + 1)]));
  for (const id of mapping.values()) newID(elements, id);
  const groups = new Map<string, string>();
  const instanceGroup = groupInstance && source.length > 1 ? crypto.randomUUID() : undefined;
  const copies = source.map(e => {
    const copy = structuredClone(e);
    const remap = (id: string | null) => id ? mapping.get(id) ?? null : null;
    const groupIds = e.groupIds.map(group => {
      if (!groups.has(group)) groups.set(group, crypto.randomUUID());
      return groups.get(group)!;
    });
    if (instanceGroup) groupIds.push(instanceGroup);
    return { ...copy, id: mapping.get(e.id)!, x: e.x + dx, y: e.y + dy,
      index: null, version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now(), groupIds,
      frameId: remap(e.frameId), boundElements: e.boundElements?.filter(b => mapping.has(b.id)).map(b => ({ ...b, id: mapping.get(b.id)! })) ?? null,
      ...(isFrameBackground(e) && !mapping.has(e.frameId!) ? { customData: { ...e.customData, diagramsFrameBackground: false } } : {}),
      ...(e.type === 'text' ? { containerId: remap(e.containerId) } : {}),
      ...(e.type === 'arrow' || e.type === 'line' ? {
        startBinding: e.startBinding && mapping.has(e.startBinding.elementId) ? { ...e.startBinding, elementId: mapping.get(e.startBinding.elementId)! } : null,
        endBinding: e.endBinding && mapping.has(e.endBinding.elementId) ? { ...e.endBinding, elementId: mapping.get(e.endBinding.elementId)! } : null,
      } : {}),
    } as Element;
  });
  return { elements: repairReferences([...elements, ...copies]), copies: [...mapping].map(([sourceId, id]) => ({ sourceId, id })) };
}

function organize(elements: Element[], operation: Extract<Operation, { op: 'align' | 'distribute' }>) {
  const selected = roots(elements, operation.ids);
  if (selected.some(isFrame)) throw new CommandError('unsupported_geometry', 'Use move or translate to position frames with their contents.');
  const boxes = selected.map(e => ({ e, b: bounds(elements, [e]) }));
  const offsets = new Map<string, Point>();
  if (operation.op === 'align') {
    const common = bounds(elements, selected);
    for (const { e, b } of boxes) {
      const alignment = operation.alignment;
      offsets.set(e.id, [alignment === 'left' ? common[0] - b[0] : alignment === 'center' ? (common[0] + common[2] - b[0] - b[2]) / 2 : alignment === 'right' ? common[2] - b[2] : 0,
        alignment === 'top' ? common[1] - b[1] : alignment === 'middle' ? (common[1] + common[3] - b[1] - b[3]) / 2 : alignment === 'bottom' ? common[3] - b[3] : 0]);
    }
  } else {
    const axis = operation.axis === 'horizontal' ? 0 : 1;
    boxes.sort((a, b) => a.b[axis] - b.b[axis] || a.e.id.localeCompare(b.e.id));
    const total = boxes.reduce((sum, { b }) => sum + b[axis + 2] - b[axis], 0);
    const gap = (boxes[boxes.length - 1].b[axis + 2] - boxes[0].b[axis] - total) / (boxes.length - 1);
    if (gap < 0) throw new CommandError('insufficient_space', 'Move the outer elements farther apart before distributing with equal gaps.');
    let cursor = boxes[0].b[axis];
    for (const { e, b } of boxes) {
      offsets.set(e.id, axis === 0 ? [cursor - b[0], 0] : [0, cursor - b[1]]);
      cursor += b[axis + 2] - b[axis] + gap;
    }
  }
  const selectedIDs = new Set(selected.map(e => e.id));
  let result = elements.map(e => {
    const delta = offsets.get(e.id) ?? (e.type === 'text' && e.containerId ? offsets.get(e.containerId) : undefined);
    if (!delta || (!delta[0] && !delta[1])) return e;
    if (e.locked) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before aligning it.');
    return newElementWith(e, { x: e.x + delta[0], y: e.y + delta[1] });
  });
  for (const e of result) if (selectedIDs.has(e.id) && isArrow(e)) { result = replace(result, routeArrow(result, e)); result = reflowLabel(result, e.id); }
  return updateAttached(result, selectedIDs, selectedIDs);
}

export function planOperations(current: readonly Element[], operations: Operation[], customShape?: (id: string) => readonly Element[]) {
  let elements = [...current];
  let backgroundColor: string | undefined;
  const copies: { sourceId: string; id: string }[] = [];
  for (const operation of operations) {
    switch (operation.op) {
      case 'create_frame': elements = createFrame(elements, operation); break;
      case 'update_frame': elements = updateFrame(elements, operation); break;
      case 'remove_frame': elements = removeFrame(elements, operation.id); break;
      case 'set_background': backgroundColor = canvasColor(operation.color); break;
      case 'reorder': elements = reorder(elements, operation); break;
      case 'insert_custom_shape': {
        if (!customShape) throw new CommandError('shape_not_found', 'Custom shapes are unavailable.');
        const source = customShape(operation.shapeId);
        const [x, y] = getCommonBounds(source);
        const inserted = copyElements(elements, source, operation.idPrefix, operation.x - x, operation.y - y, true);
        elements = inserted.elements; copies.push(...inserted.copies); break;
      }
      case 'create_shape': {
        newID(elements, operation.id);
        const created = convertToExcalidrawElements([{
          type: operation.shape, id: operation.id, x: operation.x, y: operation.y,
          width: operation.width ?? 180, height: operation.height ?? 100, angle: (operation.angle ?? 0) as Element['angle'],
          strokeColor: '#39483d', backgroundColor: '#e9f0e5', strokeWidth: 2, fillStyle: 'solid', roughness: 0, ...style(operation),
        } as Skeleton], { regenerateIds: false });
        elements = reflowLabel([...elements, ...created], operation.id, operation.label, operation); break;
      }
      case 'create_text': {
        newID(elements, operation.id);
        if (!operation.text.trim()) throw new CommandError('empty_text', 'Standalone text must contain visible text.');
        const [created] = convertToExcalidrawElements([{ type: 'text', id: operation.id, x: operation.x, y: operation.y,
          text: operation.text, fontFamily: 2, fontSize: operation.fontSize ?? 20, textAlign: operation.textAlign ?? 'left', roughness: 0,
          ...style(operation) } as Skeleton], { regenerateIds: false });
        if (created.type !== 'text') throw new CommandError('invalid_text', 'Could not create text.');
        elements.push(measureText(newElementWith(created, { x: operation.x, y: operation.y }), operation.text, operation)); break;
      }
      case 'create_line': {
        newID(elements, operation.id);
        elements.push(makeLine(operation)); break;
      }
      case 'connect': {
        newID(elements, operation.id);
        elements = repairReferences([...elements, makeArrow(elements, operation)]);
        elements = reflowLabel(elements, operation.id, operation.label, operation); break;
      }
      case 'move': {
        const e = required(elements, operation.id);
        elements = translate(elements, [e.id], operation.x - e.x, operation.y - e.y); break;
      }
      case 'translate': elements = translate(elements, operation.ids, operation.dx, operation.dy); break;
      case 'update': elements = update(elements, operation.id, operation.changes); break;
      case 'delete': elements = remove(elements, operation.ids); break;
      case 'duplicate': { const result = duplicate(elements, operation); elements = result.elements; copies.push(...result.copies); break; }
      case 'group': {
        const members = roots(elements, operation.ids);
        if (members.some(isFrame) || new Set(members.map(e => e.frameId)).size > 1) throw new CommandError('mixed_frames', 'Group content within one frame, or unframed content. Frames themselves cannot be grouped by this operation.');
        if (elements.some(e => e.groupIds.includes(operation.groupId))) throw new CommandError('duplicate_group', 'Use a fresh groupId.');
        const ids = withLabels(elements, operation.ids);
        const existing = new Set(elements.filter(e => ids.has(e.id)).flatMap(e => [...e.groupIds]));
        if (elements.some(e => !e.isDeleted && !ids.has(e.id) && e.groupIds.some(id => existing.has(id)))) throw new CommandError('partial_group', 'Include every member of existing groups, or ungroup them first.');
        for (const e of elements) if (ids.has(e.id) && e.locked) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before grouping.');
        elements = elements.map(e => ids.has(e.id) ? newElementWith(e, { groupIds: [...e.groupIds, operation.groupId] }) : e); break;
      }
      case 'ungroup': {
        for (const id of operation.groupIds) if (!elements.some(e => !e.isDeleted && e.groupIds.includes(id))) throw new CommandError('group_not_found', 'No live group has ID ' + id);
        elements = elements.map(e => {
          if (e.isDeleted || !e.groupIds.some(id => operation.groupIds.includes(id))) return e;
          if (e.locked) throw new CommandError('element_locked', 'Unlock ' + e.id + ' before ungrouping.');
          return newElementWith(e, { groupIds: e.groupIds.filter(id => !operation.groupIds.includes(id)) });
        }); break;
      }
      case 'align': case 'distribute': elements = organize(elements, operation); break;
    }
  }
  if (elements.length > 10000) throw new CommandError('element_limit', 'A diagram supports at most 10,000 elements including undo history.');
  for (const e of elements) {
    if (e.isDeleted) continue;
    if (![e.x, e.y, e.width, e.height, e.angle].every(Number.isFinite) || Math.abs(e.x) > 1000000 || Math.abs(e.y) > 1000000 || e.width < 0 || e.height < 0 || e.width > 1000000 || e.height > 1000000) throw new CommandError('invalid_geometry', 'The edit exceeds the supported canvas coordinates.');
  }
  return { elements: normalizeFrames(elements), copies, backgroundColor };
}
