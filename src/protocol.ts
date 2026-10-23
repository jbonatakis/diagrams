import Ajv, { type ErrorObject } from 'ajv';
import type { Arrowhead as NativeArrowhead } from '@excalidraw/excalidraw/element/types';
import definitions from '../shared/tools.json' with { type: 'json' };

export type Point = [number, number];
export type Style = {
  fill?: string; stroke?: string; strokeStyle?: 'solid' | 'dashed' | 'dotted';
  strokeWidth?: number; fillStyle?: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag';
  opacity?: number; roughness?: number;
};
export type TextStyle = { fontSize?: number; textAlign?: 'left' | 'center' | 'right' };
export type Arrowhead = 'none' | NativeArrowhead;
export type Routing = 'straight' | 'curved' | 'elbow';
export type ShapeOperation = Style & TextStyle & {
  op: 'create_shape'; id: string; shape: 'rectangle' | 'ellipse' | 'diamond';
  x: number; y: number; width?: number; height?: number; angle?: number; label?: string;
};
export type ConnectOperation = Style & TextStyle & {
  op: 'connect'; id: string; fromId: string; toId: string;
  label?: string; routing?: Routing;
  startArrowhead?: Arrowhead; endArrowhead?: Arrowhead;
};
export type TextOperation = Style & TextStyle & { op: 'create_text'; id: string; x: number; y: number; text: string; width?: number };
export type LineOperation = Style & { op: 'create_line'; id: string; points: Point[]; kind?: 'line' | 'arrow'; routing?: Routing; startArrowhead?: Arrowhead; endArrowhead?: Arrowhead };
export type ElementChanges = Style & TextStyle & {
  x?: number; y?: number; width?: number; height?: number; angle?: number; text?: string;
  points?: Point[]; fromId?: string | null; toId?: string | null;
  startArrowhead?: Arrowhead; endArrowhead?: Arrowhead; routing?: Routing;
};
export type MoveOperation = { op: 'move'; id: string; x: number; y: number };
export type CreateFrameOperation = { op: 'create_frame'; id: string; ids: string[]; name?: string; padding?: number; background?: string };
export type UpdateFrameOperation = { op: 'update_frame'; id: string; name?: string; padding?: number; background?: string | null };
export type Operation = ShapeOperation | ConnectOperation | TextOperation | LineOperation | MoveOperation
  | CreateFrameOperation | UpdateFrameOperation
  | { op: 'remove_frame'; id: string }
  | { op: 'set_background'; color: string }
  | { op: 'reorder'; ids: string[]; position: 'front' | 'back' | 'forward' | 'backward' }
  | { op: 'update'; id: string; changes: ElementChanges }
  | { op: 'delete'; ids: string[] }
  | { op: 'duplicate'; ids: string[]; idPrefix: string; dx?: number; dy?: number }
  | { op: 'insert_custom_shape'; shapeId: string; idPrefix: string; x: number; y: number }
  | { op: 'group'; ids: string[]; groupId: string }
  | { op: 'ungroup'; groupIds: string[] }
  | { op: 'translate'; ids: string[]; dx: number; dy: number }
  | { op: 'align'; ids: string[]; alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' }
  | { op: 'distribute'; ids: string[]; axis: 'horizontal' | 'vertical' };
export type ApplyArguments = { diagramId: string; expectedRevision: number; requestId?: string; operations: Operation[] };
export type InsertCustomShapeArguments = Omit<ApplyArguments, 'operations'> & Omit<Extract<Operation, { op: 'insert_custom_shape' }>, 'op'>;
export type ViewArguments = { diagramId: string; elementIds?: string[]; selectionOnly?: boolean; maxSize?: number };
export type CustomShapePreviewArguments = { shapeIds?: string[]; query?: string; offset?: number; limit?: number; maxSize?: number };
export type DeleteDiagramTarget = { diagramId: string; expectedRevision: number };
export type ToolName = keyof typeof definitions;

export class CommandError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(definitions).map(([name, tool]) => [name, ajv.compile(tool.inputSchema)]));
const operationValidators = new Map(definitions.apply_operations.inputSchema.properties.operations.items.oneOf
  .map(schema => [schema.properties.op.const, ajv.compile(schema)]));
const customShapeHelp = 'For imported library shapes, call list_custom_shapes, then insert_custom_shape with diagramId, expectedRevision, shapeId, idPrefix, x and y. Do not put template data in create_shape.shape.';

function validationMessage(errors: ErrorObject[] | null | undefined, path = 'data'): string {
  return (errors ?? []).map(error => {
    const field = path + error.instancePath;
    if (error.keyword === 'enum') return `${field} must be one of: ${error.params.allowedValues.map((value: unknown) => JSON.stringify(value)).join(', ')}`;
    if (error.keyword === 'additionalProperties') return `${field} has an unsupported field ${JSON.stringify(error.params.additionalProperty)}`;
    return `${field} ${error.message}`;
  }).join('; ');
}

function operationError(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || !('operations' in args) || !Array.isArray(args.operations)) return;
  for (const [index, operation] of args.operations.entries()) {
    const path = `operations[${index}]`;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return `${path} must be an object with an op field.`;
    const validate = operationValidators.get(operation.op);
    if (!validate) return `${path}.op must be one of: ${[...operationValidators.keys()].join(', ')}. Use op, not type. ${customShapeHelp}`;
    if (!validate(operation)) {
      return validationMessage(validate.errors, path) + (operation.op === 'create_shape' ? `. ${customShapeHelp}` : '');
    }
  }
}

export function validateArguments(tool: string, args: unknown): asserts tool is ToolName {
  const validate = validators[tool];
  if (!Object.hasOwn(validators, tool)) throw new CommandError('unknown_tool', `Unknown tool: ${tool}`);
  if (!validate(args)) throw new CommandError('invalid_arguments', (tool === 'apply_operations' && operationError(args)) || validationMessage(validate.errors));
}

export type Command = { type: 'command'; id: string; tool: string; arguments: unknown; deadline: number };
export type CommandResult = { type: 'result'; id: string; result?: unknown; error?: { code: string; message: string } };
