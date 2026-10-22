import { convertToExcalidrawElements, newElementWith, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawArrowElement } from '@excalidraw/excalidraw/element/types';
import { CommandError, type Operation, type ConnectOperation } from '../protocol';

type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
type Shape = Extract<ExcalidrawElement, { type: 'rectangle' | 'ellipse' | 'diamond' }>;
type Point = readonly [number, number];

const isShape = (element: ExcalidrawElement): element is Shape => ['rectangle', 'ellipse', 'diamond'].includes(element.type);
const center = (element: ExcalidrawElement): Point => [element.x + element.width / 2, element.y + element.height / 2];

function edgePoint(shape: Shape, toward: Point): Point {
  const [cx, cy] = center(shape);
  const cos = Math.cos(shape.angle), sin = Math.sin(shape.angle);
  const worldX = toward[0] - cx, worldY = toward[1] - cy;
  if (Math.hypot(worldX, worldY) < 0.01) throw new CommandError('overlapping_shapes', 'Connected shapes need different center positions.');
  const dx = worldX * cos + worldY * sin, dy = -worldX * sin + worldY * cos;
  const rx = Math.max(shape.width / 2, 1), ry = Math.max(shape.height / 2, 1);
  const scale = shape.type === 'ellipse'
    ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
    : shape.type === 'diamond'
      ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
      : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  const gap = 8 / Math.hypot(worldX, worldY);
  return [cx + worldX * (scale + gap), cy + worldY * (scale + gap)];
}

function required(elements: ExcalidrawElement[], id: string): ExcalidrawElement {
  const element = elements.find((item) => item.id === id && !item.isDeleted);
  if (!element) throw new CommandError('element_not_found', `No live element has ID ${id}. Read get_diagram for current IDs.`);
  return element;
}

function bindable(elements: ExcalidrawElement[], id: string): Shape {
  const element = required(elements, id);
  if (!isShape(element)) throw new CommandError('unsupported_shape', `Element ${id} must be a rectangle, ellipse, or diamond.`);
  return element;
}

function assertNewID(elements: ExcalidrawElement[], id: string) {
  if (elements.some((item) => item.id === id)) throw new CommandError('duplicate_id', `ID ${id} already exists, including undo history. Use a new ID.`);
}

// Use the editor's native binding constructor so human drags continue to update arrows.
// Only copies enter the constructor; no live scene element is mutated during planning.
function makeArrow(elements: ExcalidrawElement[], operation: ConnectOperation): ExcalidrawArrowElement {
  const from = bindable(elements, operation.fromId), to = bindable(elements, operation.toId);
  if (from.id === to.id) throw new CommandError('self_connection', 'Self connections are not supported in phase 1.');
  const start = edgePoint(from, center(to)), end = edgePoint(to, center(from));
  const converted = convertToExcalidrawElements([
    from, to,
    {
      type: 'arrow', id: operation.id, x: start[0], y: start[1],
      points: [[0, 0], [end[0] - start[0], end[1] - start[1]]],
      start: { id: from.id }, end: { id: to.id },
      strokeColor: operation.stroke ?? '#536357', strokeStyle: operation.strokeStyle ?? 'solid',
      strokeWidth: operation.strokeWidth ?? 2, roughness: 0,
      startArrowhead: operation.startArrowhead === 'none' ? null : operation.startArrowhead ?? null,
      endArrowhead: operation.endArrowhead === 'none' ? null : operation.endArrowhead ?? 'arrow',
    },
  ] as Skeleton[], { regenerateIds: false });
  const arrow = converted.find((item) => item.id === operation.id);
  if (arrow?.type !== 'arrow') throw new CommandError('binding_failed', 'Could not construct the connector.');
  // Binding can shift the first point away from [0, 0] without updating the
  // origin or dimensions. Apply the native restore normalization now so a
  // later save/load reports identical geometry. Keep bindings to shapes that
  // are outside this one-element array (repairBindings must remain disabled).
  const [normalized] = restoreElements([{ ...arrow, elbowed: false }], null, { repairBindings: false });
  if (normalized?.type !== 'arrow') throw new CommandError('binding_failed', 'Could not normalize the connector.');
  return { ...normalized, type: 'arrow', elbowed: false };
}

function move(elements: ExcalidrawElement[], id: string, x: number, y: number): ExcalidrawElement[] {
  const element = required(elements, id);
  if (!isShape(element) && !(element.type === 'text' && !element.containerId)) {
    throw new CommandError('unsupported_move', 'Agent moves currently support basic shapes and standalone text. Move other elements using the canvas.');
  }
  if (element.locked) throw new CommandError('element_locked', `Unlock ${id} before moving it.`);
  const arrows = elements.filter((item): item is ExcalidrawArrowElement => item.type === 'arrow' && !item.isDeleted && (item.startBinding?.elementId === id || item.endBinding?.elementId === id));
  for (const arrow of arrows) {
    if (arrow.elbowed || arrow.points.length !== 2 || arrow.angle !== 0 || !arrow.startBinding || !arrow.endBinding) {
      throw new CommandError('unsupported_connection', 'This shape has an elbow, bent, rotated, or partly unbound arrow. Move it on the canvas for now.');
    }
    bindable(elements, arrow.startBinding.elementId);
    bindable(elements, arrow.endBinding.elementId);
  }
  const dx = x - element.x, dy = y - element.y;
  let result = elements.map((item) => item.id === id || (item.type === 'text' && item.containerId === id)
    ? newElementWith(item, { x: item.x + dx, y: item.y + dy }) : item);
  for (const arrow of arrows) {
    const fresh = makeArrow(result, {
      op: 'connect', id: arrow.id, fromId: arrow.startBinding!.elementId, toId: arrow.endBinding!.elementId,
    });
    const nextArrow = newElementWith(arrow, {
      x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height,
      // A move changes geometry, not which shapes the arrow is bound to.
      // Recreating bindings also changes their focus/gap and causes native undo
      // to unbind/rebind both shapes, redrawing this connector twice.
      points: fresh.points,
    });
    const oldMid = center(arrow), newMid = center(nextArrow);
    result = result.map((item) => item.id === arrow.id ? nextArrow
      : item.type === 'text' && item.containerId === arrow.id
        ? newElementWith(item, { x: item.x + newMid[0] - oldMid[0], y: item.y + newMid[1] - oldMid[1] })
        : item);
  }
  return result;
}

export function planOperations(current: readonly ExcalidrawElement[], operations: Operation[]): ExcalidrawElement[] {
  let elements = [...current];
  for (const operation of operations) {
    switch (operation.op) {
      case 'create_shape': {
        assertNewID(elements, operation.id);
        const created = convertToExcalidrawElements([{
          type: operation.shape, id: operation.id, x: operation.x, y: operation.y,
          width: operation.width ?? 180, height: operation.height ?? 100,
          strokeColor: operation.stroke ?? '#39483d', backgroundColor: operation.fill ?? '#e9f0e5',
          strokeWidth: 2, fillStyle: 'solid', roughness: 0,
          ...(operation.label ? { label: { text: operation.label, fontFamily: 2, fontSize: 20 } } : {}),
        }], { regenerateIds: false });
        elements = [...elements, ...created];
        break;
      }
      case 'connect': {
        assertNewID(elements, operation.id);
        const arrow = makeArrow(elements, operation);
        elements = elements.map((item) => item.id === operation.fromId || item.id === operation.toId
          ? newElementWith(item, { boundElements: [...(item.boundElements ?? []), { id: arrow.id, type: 'arrow' }] }) : item);
        elements.push(arrow);
        break;
      }
      case 'move':
        elements = move(elements, operation.id, operation.x, operation.y);
        break;
    }
  }
  return elements;
}
