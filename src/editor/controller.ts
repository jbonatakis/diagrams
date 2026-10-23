import { CaptureUpdateAction, exportToCanvas } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { flushSync } from 'react-dom';
import { CommandError, validateArguments, type ApplyArguments, type Command, type ViewArguments } from '../protocol';
import { planOperations } from './operations';
import { bounds, isArrow, isFrame, isFrameBackground, selectedElements } from './elements';
import { worldPoints } from './connectors';
import { encodePreview } from './preview';
import { savedAppState, type Diagram, type Scene } from '../library/scene';

function fingerprint(elements: readonly ExcalidrawElement[]) {
  return elements.map((item) => `${item.id}:${item.version}:${item.versionNonce}:${item.isDeleted}`).join('|');
}

export class DiagramController {
  diagramId: string = crypto.randomUUID();
  revision = 0;
  private lastFingerprint = '';
  private lastView = '';
  private lastFiles: unknown;
  private lastBackground = '';
  private loading = false;
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
    if (this.loading) return;
    const next = fingerprint(this.api.getSceneElementsIncludingDeleted());
    const view = JSON.stringify(savedAppState(this.api.getAppState()));
    const files = this.api.getFiles();
    const background = this.api.getAppState().viewBackgroundColor;
    let changed = view !== this.lastView || files !== this.lastFiles;
    this.lastFiles = files;
    this.lastView = view;
    if (next !== this.lastFingerprint || background !== this.lastBackground) {
      this.lastFingerprint = next;
      this.lastBackground = background;
      this.revision += 1;
      changed = true;
    }
    if (changed) this.changed();
  }

  load(diagram: Diagram) {
    this.loading = true;
    try {
      this.diagramId = diagram.id;
      this.revision = diagram.revision;
      flushSync(() => {
        this.api.resetScene({ resetLoadingState: true });
        this.api.addFiles(Object.values(diagram.scene.files));
        this.api.updateScene({
          elements: diagram.scene.elements,
          appState: {
            ...this.api.getAppState(), ...diagram.scene.appState, selectedElementIds: {},
            // getAppState can still expose the pre-reset state in this batch.
            // A restored scene is ready; keeping isLoading also suppresses
            // native onChange events, which autosave relies on.
            isLoading: false,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      });
      this.api.history.clear();
      this.lastFingerprint = fingerprint(this.api.getSceneElementsIncludingDeleted());
      this.lastView = JSON.stringify(savedAppState(this.api.getAppState()));
      this.lastFiles = this.api.getFiles();
      this.lastBackground = this.api.getAppState().viewBackgroundColor;
    } finally { this.loading = false; }
  }

  capture(): Scene {
    this.observe();
    return structuredClone({ elements: [...this.api.getSceneElementsIncludingDeleted()], appState: savedAppState(this.api.getAppState()), files: this.api.getFiles() });
  }

  assertIdle() {
    const state = this.api.getAppState();
    if (this.pointerDown || state.editingTextElement || state.editingLinearElement) throw new CommandError('editor_busy', 'Finish the current canvas edit before switching diagrams or applying agent edits.');
  }

  snapshot() {
    this.observe();
    const elements = this.api.getSceneElements();
    const byId = new Map(elements.map((element) => [element.id, element]));
    const frameMembers = new Map<string, ExcalidrawElement[]>();
    for (const e of elements) if (e.frameId && !(e.type === 'text' && e.containerId)) {
      const members = frameMembers.get(e.frameId) ?? [];
      members.push(e); frameMembers.set(e.frameId, members);
    }
    return {
      diagramId: this.diagramId, revision: this.revision,
      backgroundColor: this.api.getAppState().viewBackgroundColor,
      selectedElementIds: Object.keys(this.api.getAppState().selectedElementIds).filter(id => byId.has(id)),
      viewport: { scrollX: this.api.getAppState().scrollX, scrollY: this.api.getAppState().scrollY, zoom: this.api.getAppState().zoom.value },
      elements: elements.filter((item) => !(item.type === 'text' && item.containerId)).map((item) => {
        const textId = item.boundElements?.find((bound) => bound.type === 'text')?.id;
        const label = textId ? byId.get(textId) : undefined;
        return {
          id: item.id, type: item.type, x: item.x, y: item.y, width: item.width, height: item.height,
          angle: item.angle, locked: item.locked, frameId: item.frameId,
          ...(isFrame(item) ? {
            name: item.name,
            memberIds: (frameMembers.get(item.id) ?? []).filter(e => !isFrameBackground(e)).map(e => e.id),
            backgroundId: frameMembers.get(item.id)?.find(isFrameBackground)?.id ?? null,
          } : {}),
          label: item.type === 'text' ? item.text : label?.type === 'text' ? label.text : undefined,
          text: item.type === 'text' ? item.originalText : label?.type === 'text' ? label.originalText : undefined,
          fontSize: item.type === 'text' ? item.fontSize : label?.type === 'text' ? label.fontSize : undefined,
          textAlign: item.type === 'text' ? item.textAlign : label?.type === 'text' ? label.textAlign : undefined,
          groupIds: item.groupIds, fillStyle: item.fillStyle, opacity: item.opacity, roughness: item.roughness,
          stroke: item.strokeColor, fill: item.backgroundColor, strokeStyle: item.strokeStyle, strokeWidth: item.strokeWidth,
          ...(item.type === 'arrow' || item.type === 'line' ? {
            points: worldPoints(item),
            fromId: item.startBinding?.elementId ?? null, toId: item.endBinding?.elementId ?? null,
            startArrowhead: item.startArrowhead, endArrowhead: item.endArrowhead,
            routing: isArrow(item) && item.elbowed ? 'elbow' : item.roundness ? 'curved' : 'straight',
          } : {}),
        };
      }),
    };
  }

  private viewTargets(args: ViewArguments) {
    if (args.diagramId !== this.diagramId) throw new CommandError('diagram_changed', 'The active diagram changed. Read it again.');
    const ids = args.selectionOnly ? Object.keys(this.api.getAppState().selectedElementIds) : args.elementIds;
    const elements = selectedElements(this.api.getSceneElements(), ids);
    if (!elements.length) throw new CommandError('empty_selection', 'There are no elements to display. Choose elements or draw something first.');
    return elements;
  }

  fit(args: ViewArguments) {
    this.assertIdle();
    const elements = this.viewTargets(args);
    flushSync(() => this.api.scrollToContent(elements, { fitToContent: true, viewportZoomFactor: 0.85, maxZoom: 2, animate: false }));
    const state = this.api.getAppState();
    return { diagramId: this.diagramId, revision: this.revision, viewport: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value } };
  }

  async preview(args: ViewArguments) {
    this.observe();
    const elements = structuredClone(this.viewTargets(args));
    const revision = this.revision;
    const sceneBounds = bounds(elements);
    const canvas = await exportToCanvas({ elements, files: structuredClone(this.api.getFiles()),
      appState: { ...savedAppState(this.api.getAppState()), exportBackground: true, exportWithDarkMode: false },
      maxWidthOrHeight: args.maxSize ?? 1200, exportPadding: 20 });
    return { diagramId: this.diagramId, revision, bounds: sceneBounds,
      elementIds: elements.filter(e => !(e.type === 'text' && e.containerId)).map(e => e.id), ...encodePreview(canvas) };
  }

  execute(command: Command, customShape?: (id: string) => readonly ExcalidrawElement[]) {
    if (Date.now() > command.deadline) throw new CommandError('expired_request', 'The request expired before execution. Read the diagram before trying again.');
    validateArguments(command.tool, command.arguments);
    if (command.tool === 'get_diagram') return { ...this.snapshot(), copies: [] as { sourceId: string; id: string }[] };
    const args = command.arguments as ApplyArguments;
    this.assertIdle();
    this.observe();
    if (args.diagramId !== this.diagramId) throw new CommandError('diagram_changed', 'This is a different browser diagram. Call get_diagram again.');
    if (args.expectedRevision !== this.revision) throw new CommandError('revision_conflict', `Expected revision ${args.expectedRevision}, current revision is ${this.revision}. Read the diagram and replan.`);
    const { elements, copies, backgroundColor } = planOperations(this.api.getSceneElementsIncludingDeleted(), args.operations, customShape);
    if (Date.now() > command.deadline) throw new CommandError('expired_request', 'The batch expired before commit. Read the diagram before trying again.');
    // Commit exactly once. Do not mutate scene objects or maintain a second history.
    // Native index repair mutates its input. Keep the previous scene untouched so
    // layer changes are also captured correctly by native history.
    flushSync(() => this.api.updateScene({ elements: structuredClone(elements),
      ...(backgroundColor === undefined ? {} : { appState: { viewBackgroundColor: backgroundColor } }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY }));
    this.observe();
    return { ...this.snapshot(), copies };
  }
}

export type DiagramSnapshot = ReturnType<DiagramController['snapshot']>;
