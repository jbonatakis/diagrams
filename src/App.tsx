import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { BrowserBridge, type Activity, type ConnectionStatus } from './bridge';
import { DiagramController, type DiagramSnapshot } from './editor/controller';

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
  const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [controller, setController] = useState<DiagramController | null>(null);
  const [snapshot, setSnapshot] = useState<DiagramSnapshot | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [copied, setCopied] = useState(false);
  const bridge = useRef<BrowserBridge | null>(null);
  const endpoint = new URL('/mcp', window.location.href).href;
  const connected = status === 'connected';
  const connecting = status === 'connecting' || status === 'reconnecting';

  useEffect(() => {
    if (!api) return;
    const next = new DiagramController(api, () => setSnapshot(next.snapshot()));
    setController(next);
    setSnapshot(next.snapshot());
    return () => { bridge.current?.disconnect(); next.dispose(); };
  }, [api]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (api?.getSceneElements().length) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [api]);

  function connect(event: FormEvent) {
    event.preventDefault();
    if (!controller || !token.trim()) return;
    bridge.current?.disconnect();
    const next = new BrowserBridge(controller, token.trim(), (nextStatus, error) => {
      setStatus(nextStatus); setConnectionError(error ?? '');
    }, (activity) => setActivities((previous) => [activity, ...previous].slice(0, 12)));
    bridge.current = next;
    next.connect();
    setToken('');
  }

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { setConnectionError('Copy the endpoint address shown below.'); }
  }

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="/" aria-label="Diagrams home" onClick={(event) => event.preventDefault()}><span className="brand-mark"><Mark /></span>Diagrams<span className="phase-label">LAB</span></a>
      <span className="header-divider" />
      <span className="document-title">Untitled diagram</span>
      <span className="memory-badge">Temporary canvas</span>
      <button className={`connection-toggle ${connected ? 'is-connected' : ''}`} onClick={() => setPanelOpen(!panelOpen)} aria-expanded={panelOpen} aria-controls="agent-panel">
        <span className={`status-dot ${connected ? 'online' : ''}`} />{connected ? 'Agent connected' : 'Connect agent'}
        <span aria-hidden="true">↗</span>
      </button>
    </header>

    <main className="workspace">
      <section className="canvas-area" aria-label="Diagram canvas" data-testid="editor">
        <Excalidraw excalidrawAPI={setAPI} initialData={initialData} theme="light" name="Untitled diagram" aiEnabled={false}
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
      </section>

      {panelOpen && <aside className="agent-panel" id="agent-panel" aria-label="Agent connection">
        <div className="panel-heading"><div><p className="eyebrow">WORK TOGETHER</p><h2>Your agent, on canvas.</h2></div><button className="icon-button" aria-label="Close agent panel" onClick={() => setPanelOpen(false)}>×</button></div>
        <p className="panel-intro">Give Codex a direct connection to this diagram. You can keep drawing while it works.</p>
        <div className={`connection-card ${connected ? 'connected' : ''}`}>
          <div className="connection-heading"><span className={`status-dot ${connected ? 'online' : connecting ? 'pending' : ''}`} /><strong data-testid="connection-status">{connected ? 'Connected' : connecting ? 'Connecting…' : 'Not connected'}</strong></div>
          <p>{connected ? 'This canvas is ready for agent tools.' : 'Connect this browser with your server token.'}</p>
          {!connected && !connecting ? <form onSubmit={connect}>
            <label htmlFor="connection-token">Connection token</label>
            <input id="connection-token" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your token" value={token} onChange={(event) => setToken(event.target.value)} />
            <button className="primary-button" disabled={!controller || !token.trim()} type="submit">Connect this canvas <span aria-hidden="true">→</span></button>
          </form> : <button className="secondary-button" onClick={() => bridge.current?.disconnect()}>{connecting ? 'Cancel connection' : 'Disconnect'}</button>}
          {connectionError && <p className="error-message" role="alert">{connectionError}</p>}
        </div>

        <div className="endpoint-section"><div className="section-label"><h3>MCP endpoint</h3><button className="text-button" onClick={copyEndpoint}>{copied ? 'Copied' : 'Copy'}</button></div><code className="endpoint">{endpoint}</code><p>Add this URL to Codex with the same bearer token. Your token stays in memory in this tab.</p></div>

        <details className="setup-details"><summary>Connect from Codex</summary><p>Add this to your Codex MCP configuration. Set <code>DIAGRAMS_TOKEN</code> in the environment used to launch Codex.</p><pre>{`[mcp_servers.diagrams]\nurl = "${endpoint}"\nbearer_token_env_var = "DIAGRAMS_TOKEN"`}</pre><p>The development server creates the token in your project’s <code>.env</code> file.</p><a href="https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server" target="_blank" rel="noreferrer">Codex connection guide ↗</a></details>

        <div className="activity-section"><div className="section-label"><h3>Activity</h3><span className="small-label">THIS SESSION</span></div>
          {activities.length === 0 ? <div className="empty-activity"><span aria-hidden="true">↔</span><p>Agent activity will appear here.</p></div> : <ol className="activity-list" aria-live="polite">{activities.map((activity) => <li key={activity.id} className={activity.error ? 'failed' : ''}><span className="activity-dot" /><div><p>{activity.label}</p><time>{activity.time}</time></div></li>)}</ol>}
        </div>
        <div className="prototype-note"><span className="note-icon" aria-hidden="true">i</span><p>This is a temporary canvas. Reloading clears the diagram. Use the canvas menu to export a copy.</p></div>
      </aside>}
    </main>

    <footer className="app-footer"><span><span className="tiny-dot" />Canvas in your browser</span><span data-testid="scene-stats">{snapshot?.elements.length ?? 0} elements <span className="footer-separator">/</span> Revision {snapshot?.revision ?? 0}</span><span className="footer-hint">Space + drag to pan <span className="footer-separator">·</span> ⌘ / Ctrl + Z to undo</span></footer>
  </div>;
}
