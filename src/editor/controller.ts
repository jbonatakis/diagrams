import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { flushSync } from 'react-dom';
import { CommandError, validateArguments, type ApplyArguments, type Command } from '../protocol';
import { planOperations } from './operations';

function fingerprint(elements: readonly ExcalidrawElement[]) {
  return elements.map((item) => `${item.id}:${item.version}:${item.versionNonce}:${item.isDeleted}`).join('|');
}

export class DiagramController {
  readonly diagramId = crypto.randomUUID();
  revision = 0;
  private lastFingerprint = '';
  private pointerDown = false;
  private disposeCallbacks: (() => void)[] = [];

  constructor(private api: ExcalidrawImperativeAPI, private changed: () => void) {
    this.lastFingerprint = fingerprint(api.getSceneElementsIncludingDeleted());
    this.disposeCallbacks = [
      api.onChange(() => this.observe()),
      api.onPointerDown(() => { this.pointerDown = true; }),
      api.onPointerUp(() => { this.pointerDown = false; }),
    ];
  }

  dispose() { for (const dispose of this.disposeCallbacks) dispose(); }

  private observe() {
    const next = fingerprint(this.api.getSceneElementsIncludingDeleted());
    if (next !== this.lastFingerprint) {
      this.lastFingerprint = next;
      this.revision += 1;
      this.changed();
    }
  }

  snapshot() {
    this.observe();
    const elements = this.api.getSceneElements();
    const byId = new Map(elements.map((element) => [element.id, element]));
    return {
      diagramId: this.diagramId, revision: this.revision,
      elements: elements.filter((item) => !(item.type === 'text' && item.containerId)).map((item) => {
        const textId = item.boundElements?.find((bound) => bound.type === 'text')?.id;
        const label = textId ? byId.get(textId) : undefined;
        return {
          id: item.id, type: item.type, x: item.x, y: item.y, width: item.width, height: item.height,
          angle: item.angle, locked: item.locked,
          label: item.type === 'text' ? item.text : label?.type === 'text' ? label.text : undefined,
          stroke: item.strokeColor, fill: item.backgroundColor, strokeStyle: item.strokeStyle, strokeWidth: item.strokeWidth,
          ...(item.type === 'arrow' ? {
            fromId: item.startBinding?.elementId ?? null, toId: item.endBinding?.elementId ?? null,
            startArrowhead: item.startArrowhead, endArrowhead: item.endArrowhead,
            points: item.points.map(([x, y]) => [item.x + x, item.y + y]),
          } : {}),
        };
      }),
    };
  }

  execute(command: Command) {
    if (Date.now() > command.deadline) throw new CommandError('expired_request', 'The request expired before execution. Read the diagram before trying again.');
    validateArguments(command.tool, command.arguments);
    if (command.tool === 'get_diagram') return this.snapshot();
    const args = command.arguments as ApplyArguments;
    const state = this.api.getAppState();
    if (this.pointerDown || state.editingTextElement || state.editingLinearElement) {
      throw new CommandError('editor_busy', 'A human is dragging, drawing, or editing text or a line. Wait for that edit to finish, then read the diagram again.');
    }
    this.observe();
    if (args.diagramId !== this.diagramId) throw new CommandError('diagram_changed', 'This is a different browser diagram. Call get_diagram again.');
    if (args.expectedRevision !== this.revision) throw new CommandError('revision_conflict', `Expected revision ${args.expectedRevision}, current revision is ${this.revision}. Read the diagram and replan.`);
    const elements = planOperations(this.api.getSceneElementsIncludingDeleted(), args.operations);
    // Commit exactly once. Do not mutate scene objects or maintain a second history.
    flushSync(() => this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY }));
    this.observe();
    return this.snapshot();
  }
}

export type DiagramSnapshot = ReturnType<DiagramController['snapshot']>;
