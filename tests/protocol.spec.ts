import { test, expect } from '@playwright/test';
import { CommandError, validateArguments } from '../src/protocol';

const target = { diagramId: 'diagram', expectedRevision: 0 };
function invalid(tool: string, args: unknown) {
  try { validateArguments(tool, args); }
  catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe('invalid_arguments');
    return (error as Error).message;
  }
  throw new Error('Expected invalid arguments');
}

test('shape format mistakes explain the supported primitives and custom shape workflow', () => {
  for (const shape of ['star', { type: 'star', elements: [] }]) {
    const message = invalid('apply_operations', { ...target, operations: [{ op: 'create_shape', id: 'star', shape, x: 0, y: 0 }] });
    expect(message).toContain('operations[0]/shape must be one of: "rectangle", "ellipse", "diamond"');
    expect(message).toContain('list_custom_shapes');
    expect(message).toContain('insert_custom_shape');
    expect(message).not.toContain('fromId'); // No failures from unrelated union branches.
    expect(message.length).toBeLessThan(600);
  }
  for (const operation of [{ type: 'create_element' }, { op: 'create_element' }, null]) {
    const message = invalid('apply_operations', { ...target, operations: [operation] });
    expect(message).toContain('operations[0]');
    expect(message).toContain('op');
    if (operation) expect(message).toContain('Use op, not type');
  }
});

test('dedicated and batch insertion validate the same template fields without accepting nested data', () => {
  const shape = { shapeId: 'installed-template', idPrefix: 'copy', x: 100, y: 200 };
  const check = (fields: Record<string, unknown>) => {
    expect(() => validateArguments('insert_custom_shape', { ...target, ...fields })).not.toThrow();
    expect(() => validateArguments('apply_operations', { ...target, operations: [{ op: 'insert_custom_shape', ...fields }] })).not.toThrow();
  };
  check(shape);
  for (const fields of [{ ...shape, x: 1000001 }, { ...shape, idPrefix: 'bad prefix' }, { ...shape, shape: {} }, { shapeId: shape.shapeId }]) {
    invalid('insert_custom_shape', { ...target, ...fields });
    invalid('apply_operations', { ...target, operations: [{ op: 'insert_custom_shape', ...fields }] });
  }
  expect(invalid('insert_custom_shape', { ...shape, diagramId: target.diagramId })).toContain('expectedRevision');
});

test('validation reports only the failed operation and still enforces the batch envelope', () => {
  const operations = [{ op: 'create_shape', id: 'box', shape: 'rectangle', x: 0, y: 0 }, { op: 'move', id: 'box', x: 10 }];
  const message = invalid('apply_operations', { ...target, operations });
  expect(message).toContain('operations[1]');
  expect(message).toContain("required property 'y'");
  expect(message).not.toContain('shapeId');
  expect(invalid('apply_operations', { ...target, expectedRevision: -1, operations: operations.slice(0, 1) })).toContain('expectedRevision');
  expect(invalid('apply_operations', { ...target, operations: [] })).toContain('fewer than 1 items');
});

test('custom shape previews allow browsing or explicit IDs, with bounded image and page sizes', () => {
  for (const args of [{}, { query: 'server', offset: 12, limit: 12 }, { shapeIds: ['one', 'two'], maxSize: 512 }]) {
    expect(() => validateArguments('preview_custom_shapes', args)).not.toThrow();
  }
  for (const args of [
    { shapeIds: [] }, { shapeIds: ['one', 'one'] }, { shapeIds: Array.from({ length: 17 }, (_, i) => String(i)) },
    { limit: 17 }, { offset: -1 }, { maxSize: 1601 },
    { shapeIds: ['one'], query: 'server' }, { shapeIds: ['one'], offset: 0 }, { shapeIds: ['one'], limit: 1 },
  ]) invalid('preview_custom_shapes', args);
});

test('frame and layer operations validate their fields and report actionable errors', () => {
  for (const operation of [
    { op: 'create_frame', id: 'section', ids: ['box'], name: 'Server', padding: 40, background: '#e1e8e5' },
    { op: 'update_frame', id: 'section', background: null },
    { op: 'update_frame', id: 'section', padding: 0, name: '' },
    { op: 'remove_frame', id: 'section' },
    { op: 'set_background', color: '#ffffff' },
    ...['front', 'back', 'forward', 'backward'].map(position => ({ op: 'reorder', ids: ['section'], position })),
  ]) expect(() => validateArguments('apply_operations', { ...target, operations: [operation] })).not.toThrow();
  for (const operation of [
    { op: 'create_frame', id: 'section', ids: [] },
    { op: 'create_frame', id: 'section', ids: ['box'], padding: -1 },
    { op: 'create_frame', id: 'section', ids: ['box'], background: null },
    { op: 'update_frame', id: 'section' },
    { op: 'update_frame', id: 'section', width: 200 },
    { op: 'set_background', color: 'var(--color)' },
    { op: 'reorder', ids: ['box', 'box'], position: 'front' },
    { op: 'remove_frame', id: 'section', deleteContents: true },
  ]) invalid('apply_operations', { ...target, operations: [operation] });
  expect(invalid('apply_operations', { ...target, operations: [{ op: 'reorder', ids: ['box'], position: 'top' }] }))
    .toContain('"front", "back", "forward", "backward"');
});

test('every native endpoint marker is accepted on lines, connections and direct edits', () => {
  const heads = ['none', 'arrow', 'triangle', 'bar', 'dot', 'circle', 'circle_outline', 'triangle_outline',
    'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'];
  for (const head of heads) for (const routing of ['straight', 'curved', 'elbow']) {
    for (const operation of [
      { op: 'create_line', id: 'line', kind: 'line', points: [[0, 0], [100, 100], [200, 0]], startArrowhead: head, endArrowhead: head, routing },
      { op: 'connect', id: 'link', fromId: 'a', toId: 'b', startArrowhead: head, endArrowhead: head, routing },
      { op: 'update', id: 'existing-line', changes: { startArrowhead: head, endArrowhead: head, routing } },
    ]) expect(() => validateArguments('apply_operations', { ...target, operations: [operation] })).not.toThrow();
  }
  const message = invalid('apply_operations', { ...target, operations: [{ op: 'update', id: 'line', changes: { endArrowhead: 'optional_many' } }] });
  expect(message).toContain('crowfoot_many'); expect(message).toContain('circle_outline');
  expect(message).not.toContain('fromId');
});
