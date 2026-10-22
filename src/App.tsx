import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useAgentConnection, AgentConnectionPanel } from './connection';
import { openWorkspace, type Workspace } from './library/workspace';
import { LibraryPanel, FileActions, importFile } from './library/ui';
import type { DiagramMeta } from './library/scene';

const initialData = {
  appState: {
    viewBackgroundColor: '#fcfcf9', currentItemRoughness: 0, currentItemFontFamily: 2,
    currentItemStrokeColor: '#39483d', currentItemBackgroundColor: '#e9f0e5',
    currentItemFillStyle: 'solid' as const,
  },
};

function Mark() {
  return <svg width="25" height="25" viewBox="0 0 25 25" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <rect x="15" y="15" width="8" height="8" rx="4" stroke="currentColor" strokeWidth="1.6" />
    <path d="M6 10v9h9" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [error, setError] = useState('');
  function load() { setError(''); void openWorkspace().then(setWorkspace).catch((failure: Error) => setError(failure.message)); }
  useEffect(load, []);
  if (!workspace) return <main className="loading-screen"><Mark /><h1>{error ? 'Could not open your library' : 'Opening your diagrams…'}</h1>{error && <><p role="alert">{error}</p><button className="secondary-button" onClick={load}>Retry</button></>}</main>;
  return <WorkspaceView workspace={workspace} />;
}

function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const { snapshot } = state;
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [uiError, setUIError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ready = !!workspace.controller;
  const disabled = state.busy || working || !ready;
  async function act(action: () => Promise<unknown>) {
    setUIError(''); setNotice(''); setWorking(true);
    try { await action(); } catch (failure) { setUIError(failure instanceof Error ? failure.message : 'The action could not be completed.'); }
    finally { setWorking(false); }
  }
  async function open(id: string) {
    await workspace.run('open_diagram', { diagramId: id, expectedActiveDiagramId: workspace.active.id, expectedActiveRevision: workspace.controller!.revision });
  }
  function manage(item: DiagramMeta, action: string, name?: string) {
    return workspace.run('manage_diagram', { diagramId: item.id, expectedRevision: item.id === workspace.active.id ? workspace.controller!.revision : item.revision, action, ...(name === undefined ? {} : { name }) });
  }
  const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const connection = useAgentConnection(workspace);
  const connected = connection.status === 'connected';

  useEffect(() => {
    if (!api) return;
    let detach: (() => void) | undefined;
    const timer = setTimeout(() => { detach = workspace.attach(api); }, 0);
    return () => { clearTimeout(timer); detach?.(); };
  }, [api, workspace]);


  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (workspace.hasUnsavedChanges) event.preventDefault();
    };
    const flush = () => { if (document.visibilityState === 'hidden') void workspace.flush().catch(() => {}); };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', flush);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', flush); };
  }, [workspace]);

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="/" aria-label="Diagrams home" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Mark /></span>Diagrams<span className="phase-label">LAB</span></a>
      <span className="header-divider" />
      <button className="library-toggle" aria-label="Diagram library" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>▤ <span>Library</span></button>
      <input key={state.active.id + state.active.name} className="document-title" aria-label="Diagram name" maxLength={120} defaultValue={state.active.name} disabled={disabled}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = state.active.name; event.currentTarget.blur(); } }}
        onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name !== state.active.name) { event.currentTarget.value = state.active.name; void act(() => manage(state.active, 'rename', name)); } }} />
      <span className={`save-badge ${state.saveStatus}`} data-testid="save-status" role="status">{({ saved: 'Saved in browser', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Save failed' })[state.saveStatus]}</span>
      <FileActions disabled={disabled} workspace={workspace} act={act} onImport={() => fileInput.current?.click()} />
      <button className={`connection-toggle ${connected ? 'is-connected' : ''}`} onClick={() => setPanelOpen(!panelOpen)} aria-expanded={panelOpen} aria-controls="agent-panel">
        <span className={`status-dot ${connected ? 'online' : ''}`} />{connected ? 'Canvas connected' : 'Connect agent'}
        <span aria-hidden="true">↗</span>
      </button>
    </header>

    <input ref={fileInput} type="file" accept=".excalidraw,.json,application/json" aria-label="Import file" className="hidden-file" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void act(async () => {
        const result = await importFile(workspace, file);
        if (result.id) { await open(result.id); setNotice('Diagram imported.'); }
        else setNotice(`Imported ${result.count} diagrams. Open the library to choose one.`);
      });
    }} />
    {(uiError || state.error) && <div className="workspace-error" role="alert"><span>{uiError || state.error}</span>{state.saveStatus === 'error' && <button onClick={() => void act(() => workspace.retrySave())}>Retry saving</button>}<button aria-label="Dismiss error" onClick={() => { setUIError(''); workspace.dismissError(); }}>×</button></div>}
    {notice && <div className="workspace-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
    <main className="workspace">
      {libraryOpen && <LibraryPanel state={state} disabled={disabled} onClose={() => setLibraryOpen(false)} onOpen={(id) => void act(() => open(id))}
        onCreate={() => void act(async () => { const created = await workspace.run('create_diagram') as DiagramMeta; await open(created.id); })}
        onManage={(item, action) => void act(() => manage(item, action))} />}

      <section className="canvas-area" aria-label="Diagram canvas" data-testid="editor" inert={disabled}>
        <Excalidraw key={state.editorEpoch} excalidrawAPI={setAPI} initialData={initialData} theme="light" name={state.active.name} aiEnabled={false}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: { saveFileToDisk: true } } }}>
          <MainMenu>
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <div className="canvas-welcome">
                <div className="welcome-symbol"><Mark /></div>
                <p className="eyebrow">ROOM TO THINK</p>
                <h1>Start with a shape.</h1>
                <p>Draw something yourself, or connect your agent<br className="desktop-break" /> and build it together.</p>
                <div className="shortcut-row"><span><kbd>R</kbd> Rectangle</span><span><kbd>O</kbd> Ellipse</span><span><kbd>A</kbd> Arrow</span></div>
              </div>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
        {(state.busy || working || !ready) && <div className="canvas-busy" aria-label="Updating library" />}
      </section>

      {panelOpen && <AgentConnectionPanel connection={connection} onClose={() => setPanelOpen(false)} />}
    </main>

    <footer className="app-footer"><span><span className="tiny-dot" />Canvas in your browser</span><span data-testid="scene-stats">{snapshot?.elements.length ?? 0} elements <span className="footer-separator">/</span> Revision {snapshot?.revision ?? 0}</span><span className="footer-hint">Space + drag to pan <span className="footer-separator">·</span> ⌘ / Ctrl + Z to undo</span></footer>
  </div>;
}
