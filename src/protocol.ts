import Ajv from 'ajv';
import definitions from '../shared/tools.json';

export type ShapeOperation = {
  op: 'create_shape'; id: string; shape: 'rectangle' | 'ellipse' | 'diamond';
  x: number; y: number; width?: number; height?: number;
  label?: string; fill?: string; stroke?: string;
};
export type ConnectOperation = {
  op: 'connect'; id: string; fromId: string; toId: string;
  stroke?: string; strokeStyle?: 'solid' | 'dashed' | 'dotted'; strokeWidth?: number;
  startArrowhead?: 'none' | 'arrow' | 'triangle'; endArrowhead?: 'none' | 'arrow' | 'triangle';
};
export type MoveOperation = { op: 'move'; id: string; x: number; y: number };
export type Operation = ShapeOperation | ConnectOperation | MoveOperation;
export type ApplyArguments = { diagramId: string; expectedRevision: number; operations: Operation[] };
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
