import Ajv from 'ajv';
import definitions from '../shared/tools.json';

export type Point = [number, number];
export type Style = {
  fill?: string; stroke?: string; strokeStyle?: 'solid' | 'dashed' | 'dotted';
  strokeWidth?: number; fillStyle?: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag';
  opacity?: number; roughness?: number;
};
export type TextStyle = { fontSize?: number; textAlign?: 'left' | 'center' | 'right' };
export type Arrowhead = 'none' | 'arrow' | 'triangle' | 'bar' | 'dot';
export type ShapeOperation = Style & TextStyle & {
  op: 'create_shape'; id: string; shape: 'rectangle' | 'ellipse' | 'diamond';
  x: number; y: number; width?: number; height?: number; angle?: number; label?: string;
};
export type ConnectOperation = Style & TextStyle & {
  op: 'connect'; id: string; fromId: string; toId: string;
  label?: string; routing?: 'straight' | 'elbow';
  startArrowhead?: Arrowhead; endArrowhead?: Arrowhead;
};
export type TextOperation = Style & TextStyle & { op: 'create_text'; id: string; x: number; y: number; text: string; width?: number };
export type LineOperation = Style & { op: 'create_line'; id: string; points: Point[]; kind?: 'line' | 'arrow'; startArrowhead?: Arrowhead; endArrowhead?: Arrowhead };
export type ElementChanges = Style & TextStyle & {
  x?: number; y?: number; width?: number; height?: number; angle?: number; text?: string;
  points?: Point[]; fromId?: string | null; toId?: string | null;
  startArrowhead?: Arrowhead; endArrowhead?: Arrowhead; routing?: 'straight' | 'elbow';
};
export type MoveOperation = { op: 'move'; id: string; x: number; y: number };
export type Operation = ShapeOperation | ConnectOperation | TextOperation | LineOperation | MoveOperation
  | { op: 'update'; id: string; changes: ElementChanges }
  | { op: 'delete'; ids: string[] }
  | { op: 'duplicate'; ids: string[]; idPrefix: string; dx?: number; dy?: number }
  | { op: 'group'; ids: string[]; groupId: string }
  | { op: 'ungroup'; groupIds: string[] }
  | { op: 'translate'; ids: string[]; dx: number; dy: number }
  | { op: 'align'; ids: string[]; alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' }
  | { op: 'distribute'; ids: string[]; axis: 'horizontal' | 'vertical' };
export type ApplyArguments = { diagramId: string; expectedRevision: number; requestId?: string; operations: Operation[] };
export type ViewArguments = { diagramId: string; elementIds?: string[]; selectionOnly?: boolean; maxSize?: number };
export type ToolName = keyof typeof definitions;

export class CommandError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(definitions).map(([name, tool]) => [name, ajv.compile(tool.inputSchema)]));

export function validateArguments(tool: string, args: unknown): asserts tool is ToolName {
  const validate = validators[tool];
  if (!validate) throw new CommandError('unknown_tool', `Unknown tool: ${tool}`);
  if (!validate(args)) throw new CommandError('invalid_arguments', ajv.errorsText(validate.errors, { separator: '; ' }));
}

export type Command = { type: 'command'; id: string; tool: string; arguments: unknown; deadline: number };
export type CommandResult = { type: 'result'; id: string; result?: unknown; error?: { code: string; message: string } };
