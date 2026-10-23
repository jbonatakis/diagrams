import { convertToExcalidrawElements, newElementWith, restoreElements, ROUNDNESS } from '@excalidraw/excalidraw';
import type { ExcalidrawArrowElement, ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types';
import { CommandError, type ConnectOperation, type LineOperation, type Point, type Routing } from '../protocol';
import { center, isShape, isArrow, required, reflowLabel, style, type Element, type Skeleton } from './elements';

export function worldPoints(e: Element): Point[] {
  if (e.type !== 'line' && e.type !== 'arrow' && e.type !== 'freedraw') return [];
  const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1]);
  const cx = e.x + (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = e.y + (Math.min(...ys) + Math.max(...ys)) / 2;
  const cos = Math.cos(e.angle), sin = Math.sin(e.angle);
  return e.points.map(([x, y]) => {
    const dx = e.x + x - cx, dy = e.y + y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}
function edgePoint(shape: Element, toward: Point): Point {
  const [cx, cy] = center(shape);
  const cos = Math.cos(shape.angle), sin = Math.sin(shape.angle);
  const worldX = toward[0] - cx, worldY = toward[1] - cy;
  if (Math.hypot(worldX, worldY) < 0.01) throw new CommandError('overlapping_shapes', 'Connected shapes need different center positions.');
  const dx = worldX * cos + worldY * sin, dy = -worldX * sin + worldY * cos;
  const rx = Math.max(shape.width / 2, 1), ry = Math.max(shape.height / 2, 1);
  const scale = shape.type === 'ellipse'
    ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    : shape.type === 'diamond' ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
      : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  const gap = 8 / Math.hypot(worldX, worldY);
  return [cx + worldX * (scale + gap), cy + worldY * (scale + gap)];
}
function elbowPoints(start: Point, end: Point, horizontal: boolean): Point[] {
  const mid = horizontal ? (start[0] + end[0]) / 2 : (start[1] + end[1]) / 2;
  const points: Point[] = horizontal
    ? [start, [mid, start[1]], [mid, end[1]], end]
    : [start, [start[0], mid], [end[0], mid], end];
  return points.filter((p, i) => !i || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}
export function geometry(points: Point[]) {
  if (points.length < 2 || points.every(p => p[0] === points[0][0] && p[1] === points[0][1])) throw new CommandError('invalid_geometry', 'A line needs at least two distinct points.');
  const x = points[0][0], y = points[0][1];
  return { x, y, angle: 0 as Element['angle'], width: Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])),
    height: Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])),
    points: points.map(p => [p[0] - x, p[1] - y]) as ExcalidrawArrowElement['points'] };
}

// Excalidraw renders endpoint markers and bindings only on native arrows. A
// plain line is upgraded in place: same ID, path, groups, frame and styling.
export function asArrow(line: ExcalidrawLinearElement): ExcalidrawArrowElement {
  if (line.type === 'arrow') return line as ExcalidrawArrowElement;
  if (line.backgroundColor !== 'transparent' && line.points.length > 2) {
    const [first, last] = [line.points[0], line.points[line.points.length - 1]];
    // Excalidraw 0.18 treats endpoints within eight scene units as a closed path.
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 8) {
      throw new CommandError('filled_path', 'Open this filled path or clear its fill before adding endpoint markers or bindings.');
    }
  }
  return { ...newElementWith(line, { type: 'arrow' }), elbowed: false } as ExcalidrawArrowElement;
}

export function setRouting(line: ExcalidrawLinearElement, routing: Routing): ExcalidrawLinearElement {
  const wasElbow = line.type === 'arrow' && (line as ExcalidrawArrowElement).elbowed;
  if (routing === 'elbow') line = asArrow(line);
  const points = worldPoints(line);
  return newElementWith(line, {
    ...(routing === 'elbow' || wasElbow ? geometry([points[0], points[points.length - 1]]) : {}),
    ...(line.type === 'arrow' ? { elbowed: routing === 'elbow', fixedSegments: null, startIsSpecial: false, endIsSpecial: false } : {}),
    roundness: routing === 'curved' ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
  });
}

export function makeLine(op: LineOperation): ExcalidrawLinearElement {
  const markers = [op.startArrowhead, op.endArrowhead].some(head => head && head !== 'none');
  const type = op.kind ?? 'line';
  const created = convertToExcalidrawElements([{ type, id: op.id, ...geometry(op.points),
    strokeColor: '#536357', strokeWidth: 2, roughness: 0, ...style(op),
    startArrowhead: op.startArrowhead === 'none' ? null : op.startArrowhead ?? null,
    // Requesting a marker on a plain line must not add an unrequested arrowhead.
    endArrowhead: op.endArrowhead === 'none' ? null : op.endArrowhead ?? (op.kind === 'arrow' ? 'arrow' : null),
  } as Skeleton], { regenerateIds: false });
  const [restored] = restoreElements(created, null, { repairBindings: false });
  // The native line constructor clears arrowheads, even when supplied in the
  // skeleton. Reapply them after construction before upgrading the line.
  let line = newElementWith(restored as ExcalidrawLinearElement, { ...geometry(op.points),
    startArrowhead: op.startArrowhead === 'none' ? null : op.startArrowhead ?? null,
    endArrowhead: op.endArrowhead === 'none' ? null : op.endArrowhead ?? (op.kind === 'arrow' ? 'arrow' : null),
  });
  if (markers) line = asArrow(line);
  if (op.routing) line = setRouting(line, op.routing);
  return line.type === 'arrow' ? routeArrow([], line as ExcalidrawArrowElement) : line;
}

// Bind using the public constructor so subsequent human drags use native bindings.
export function routeArrow(elements: Element[], arrow: ExcalidrawArrowElement, rebind = false): ExcalidrawArrowElement {
  const from = arrow.startBinding ? required(elements, arrow.startBinding.elementId) : undefined;
  const to = arrow.endBinding ? required(elements, arrow.endBinding.elementId) : undefined;
  if (!from && !to && !arrow.elbowed) return arrow;
  if (from && to && from.id === to.id) throw new CommandError('self_connection', 'Use separate shapes for the two ends of a connector.');
  let points = worldPoints(arrow);
  let start = points[0], end = points[points.length - 1];
  if (arrow.elbowed) {
    const a = from ? center(from) : start, b = to ? center(to) : end;
    const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const sign = Math.sign(horizontal ? b[0] - a[0] : b[1] - a[1]) || 1;
    if (from) start = edgePoint(from, horizontal ? [a[0] + sign, a[1]] : [a[0], a[1] + sign]);
    if (to) end = edgePoint(to, horizontal ? [b[0] - sign, b[1]] : [b[0], b[1] - sign]);
    points = elbowPoints(start, end, horizontal);
  } else {
    if (from) start = edgePoint(from, points.length === 2 && to ? center(to) : points[1]);
    if (to) end = edgePoint(to, points.length === 2 && from ? center(from) : points[points.length - 2]);
    points = [start, ...points.slice(1, -1), end];
  }
  if (!from && !to) return newElementWith(arrow, { ...geometry(points), ...(arrow.elbowed ? { fixedSegments: null } : {}) });
  // Skeleton supports basic shape endpoints. Existing bindings to other element
  // kinds retain their native binding metadata while their geometry is updated.
  const canConstruct = (!from || isShape(from)) && (!to || isShape(to));
  if (!canConstruct) return newElementWith(arrow, geometry(points));
  const skeleton = {
    ...arrow, ...geometry(points), boundElements: null, startBinding: null, endBinding: null,
    ...(arrow.elbowed ? { fixedSegments: null, startIsSpecial: false, endIsSpecial: false } : {}),
    ...(from ? { start: { id: from.id } } : {}), ...(to ? { end: { id: to.id } } : {}),
  };
  const created = convertToExcalidrawElements([...(from ? [from] : []), ...(to ? [to] : []), skeleton] as Skeleton[], { regenerateIds: false });
  const raw = created.find(e => e.id === arrow.id)!;
  const [fresh] = restoreElements([raw], null, { repairBindings: false });
  if (fresh?.type !== 'arrow') throw new CommandError('binding_failed', 'Could not construct the connector.');
  // The native constructor nudges both ends to establish binding gaps. A free
  // endpoint must stay where the user placed it, including after repeated moves.
  const adjusted = worldPoints(fresh);
  if (!from) adjusted[0] = points[0];
  if (!to) adjusted[adjusted.length - 1] = points[points.length - 1];
  return newElementWith(arrow, {
    x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height, angle: fresh.angle, points: fresh.points,
    ...(!from || !to ? geometry(adjusted) : {}),
    ...((rebind || arrow.elbowed) ? { startBinding: fresh.startBinding, endBinding: fresh.endBinding } : {}),
    ...(arrow.elbowed ? { fixedSegments: null, startIsSpecial: false, endIsSpecial: false } : {}),
  });
}
export function makeArrow(elements: Element[], op: ConnectOperation): ExcalidrawArrowElement {
  const from = required(elements, op.fromId), to = required(elements, op.toId);
  if (!isShape(from) || !isShape(to)) throw new CommandError('unsupported_shape', 'Connect endpoints must be rectangles, ellipses, or diamonds.');
  const a = center(from), b = center(to);
  const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const points = op.routing === 'elbow' ? elbowPoints(a, b, horizontal) : [a, b];
  const [raw] = convertToExcalidrawElements([{
    type: 'arrow', id: op.id, ...geometry(points), elbowed: op.routing === 'elbow',
    roundness: op.routing === 'curved' ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
    strokeColor: '#536357', strokeWidth: 2, roughness: 0, ...style(op),
    startArrowhead: op.startArrowhead === 'none' ? null : op.startArrowhead ?? null,
    endArrowhead: op.endArrowhead === 'none' ? null : op.endArrowhead ?? 'arrow',
  } as Skeleton], { regenerateIds: false });
  const arrow = { ...raw, startBinding: { elementId: from.id, focus: 0, gap: 8 }, endBinding: { elementId: to.id, focus: 0, gap: 8 } } as ExcalidrawArrowElement;
  return routeArrow(elements, arrow, true);
}
export function repairReferences(elements: Element[]): Element[] {
  const references = new Map<string, NonNullable<Element['boundElements']>[number][]>();
  const add = (id: string, value: NonNullable<Element['boundElements']>[number]) => {
    const items = references.get(id) ?? []; items.push(value); references.set(id, items);
  };
  for (const e of elements) {
    if (e.isDeleted) continue;
    if (e.type === 'text' && e.containerId) add(e.containerId, { type: 'text', id: e.id });
    if (e.type === 'arrow') for (const id of new Set([e.startBinding?.elementId, e.endBinding?.elementId])) if (id) add(id, { type: 'arrow', id: e.id });
  }
  return elements.map(e => {
    if (e.isDeleted) return e;
    const refs = references.get(e.id) ?? [];
    return JSON.stringify(refs) === JSON.stringify(e.boundElements ?? []) ? e : newElementWith(e, { boundElements: refs });
  });
}
export function updateAttached(elements: Element[], changed: ReadonlySet<string>, skip = new Set<string>()): Element[] {
  let result = elements;
  for (const e of elements) {
    if (e.isDeleted || !isArrow(e) || skip.has(e.id) || ![e.startBinding?.elementId, e.endBinding?.elementId].some(id => id && changed.has(id))) continue;
    if (e.locked) throw new CommandError('element_locked', 'Unlock attached connector ' + e.id + ' before changing its shape.');
    const next = routeArrow(result, e);
    result = result.map(item => item.id === e.id ? next : item);
    result = reflowLabel(result, e.id);
  }
  return repairReferences(result);
}

