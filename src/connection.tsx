import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserBridge, type Activity, type ConnectionStatus } from './bridge';
import type { Workspace } from './library/workspace';

type Session = { csrf: string; endpoint: string };
type Agent = { id: string; name: string; createdAt: number; expiresAt: number };
const pauseKey = 'diagrams-agent-paused';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error_description ?? 'The connection server is unavailable.');
  }
  return response.json() as Promise<T>;
}

export function useAgentConnection(workspace: Workspace) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [paused, setPaused] = useState(() => localStorage.getItem(pauseKey) === 'true');
  const [error, setError] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState(new URL('/mcp', location.href).href);
  const session = useRef<Session | undefined>(undefined);
  const bridge = useRef<BrowserBridge | undefined>(undefined);
  const alive = useRef(false);

  const refresh = useCallback(async () => {
    if (!session.current) return;
    try {
      const data = await request<{ agents: Agent[] }>('/api/agents');
      if (alive.current) setAgents(data.agents);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Could not list agents.');
    }
  }, []);

  const connect = useCallback(() => {
    localStorage.removeItem(pauseKey);
    setPaused(false);
    bridge.current?.disconnect();
    const next = new BrowserBridge(workspace, async () => {
      const data = await request<Session>('/api/session', { method: 'POST', headers: { 'X-Diagrams-Request': '1' } });
      if (!alive.current) return;
      session.current = data; setEndpoint(data.endpoint);
      void refresh();
    }, (state, message) => {
      if (alive.current) { setStatus(state); setError(message ?? ''); }
    }, (activity) => {
      if (alive.current) setActivities(previous => [activity, ...previous].slice(0, 12));
    });
    bridge.current = next;
    void next.connect();
  }, [workspace, refresh]);

  function disconnect() {
    localStorage.setItem(pauseKey, 'true');
    setPaused(true);
    bridge.current?.disconnect();
  }

  useEffect(() => {
    alive.current = true;
    // Defer bootstrap past React StrictMode's setup/cleanup probe.
    const start = setTimeout(() => {
      if (localStorage.getItem(pauseKey) !== 'true') connect();
      else void request<Session>('/api/session').then(data => {
        if (!alive.current) return;
        session.current = data; setEndpoint(data.endpoint); void refresh();
      }).catch(() => {});
    }, 0);
    const focus = () => void refresh();
    const timer = setInterval(focus, 5000);
    window.addEventListener('focus', focus);
    return () => {
      alive.current = false; clearTimeout(start); clearInterval(timer);
      window.removeEventListener('focus', focus); bridge.current?.disconnect();
    };
  }, [connect, refresh]);

  async function mutate(path: string) {
    if (!session.current) throw new Error('Resume agent access first.');
    await request(path, { method: 'POST', headers: { 'X-Diagrams-CSRF': session.current.csrf } });
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await mutate('/api/agents/' + encodeURIComponent(id) + '/revoke'); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not revoke access.'); }
    finally { setBusy(false); }
  }
  async function forget() {
    setBusy(true); setError('');
    try {
      await mutate('/api/forget');
      disconnect(); session.current = undefined; setAgents([]); setActivities([]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not forget this browser.'); }
    finally { setBusy(false); }
  }

  return { status, paused, error, activities, agents, busy, endpoint, connect, disconnect, revoke, forget, refresh };
}

export function AgentConnectionPanel({ connection, onClose }: {
  connection: ReturnType<typeof useAgentConnection>; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const { status, paused, error, agents, busy, endpoint, activities } = connection;
  const connected = status === 'connected';
  const connecting = status === 'connecting' || status === 'reconnecting';
  async function copy() {
    try { await navigator.clipboard.writeText(endpoint); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <aside className="agent-panel" id="agent-panel" aria-label="Agent connection">
    <section className="agent-setup" aria-labelledby="agent-setup-heading">
      <div className="panel-heading">
        <h2 id="agent-setup-heading">Set up your agent</h2>
        <button className="icon-button agent-panel-close" aria-label="Close agent panel" onClick={onClose}>×</button>
      </div>
      <p>Add this URL in your agent’s MCP settings, then authenticate and approve access in this browser.</p>
      <code className="endpoint">{endpoint}</code>
      <button className="primary-button copy-endpoint" onClick={copy}>{copied ? 'Copied MCP URL' : 'Copy MCP URL'}</button>
      <details className="setup-details"><summary>Codex instructions</summary>
        <p>Add this URL in MCP settings and choose Authenticate. Keep this app open in the browser where you approve access.</p>
        <pre>{`[mcp_servers.diagrams]\nurl = "${endpoint}"`}</pre>
        <p>From the terminal: <code>codex mcp login diagrams</code></p>
        <a href="https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server" target="_blank" rel="noreferrer">Codex connection guide ↗</a>
      </details>
    </section>
    <div className={`connection-card ${connected ? 'connected' : ''}`}>
      <div className="connection-heading">
        <span aria-hidden="true" className={`status-dot ${connected ? 'online' : connecting ? 'pending' : ''}`} />
        <strong data-testid="connection-status" role="status">{paused ? 'Agent access paused' : connected ? 'Canvas ready' : connecting ? 'Preparing canvas…' : 'Canvas unavailable'}</strong>
      </div>
      <p>{paused ? 'Approved agents cannot use this library while access is paused.' : connected ? 'Your canvas is ready for approved agents. Keep this tab open.' : connecting ? 'Your browser reconnects automatically. You can keep drawing.' : 'Resume agent access to make this library available again.'}</p>
      {connected || connecting
        ? <button className="secondary-button" onClick={connection.disconnect}>Pause agent access</button>
        : <button className="secondary-button" onClick={connection.connect}>Resume agent access</button>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
    <div className="paired-agents">
      <div className="section-label"><h3>Approved agents</h3><button className="text-button" onClick={() => void connection.refresh()}>Refresh</button></div>
      {agents.length === 0 ? <p>No agents approved yet.</p> : <ul>{agents.map(agent =>
        <li key={agent.id}><div><strong>{agent.name}</strong><small>Approved {new Date(agent.createdAt * 1000).toLocaleDateString()}</small></div><button className="text-button" disabled={busy} onClick={() => void connection.revoke(agent.id)} aria-label={`Revoke ${agent.name}`}>Revoke</button></li>)}</ul>}
      {!confirmForget ? <button className="text-button forget-button" onClick={() => setConfirmForget(true)}>Forget this browser</button> :
        <div className="forget-confirmation"><p>Remove every agent’s access and forget this browser’s pairing? Your local diagrams will remain.</p><button className="secondary-button" disabled={busy} onClick={async () => { await connection.forget(); setConfirmForget(false); }}>Forget pairings</button><button className="text-button" onClick={() => setConfirmForget(false)}>Cancel</button></div>}
    </div>
    <div className="activity-section"><div className="section-label"><h3>Activity</h3><span className="small-label">THIS SESSION</span></div>
      {activities.length === 0 ? <div className="empty-activity"><span aria-hidden="true">↔</span><p>Agent activity will appear here.</p></div> : <ol className="activity-list" aria-live="polite">{activities.map(activity => <li key={activity.id} className={activity.error ? 'failed' : ''}><span className="activity-dot" /><div><p>{activity.label}</p><time>{activity.time}</time></div></li>)}</ol>}
    </div>
    <div className="prototype-note"><span className="note-icon" aria-hidden="true">i</span><p>No account is needed. Diagrams stay in this browser; agent requests pass through the connection server without being saved there. Export a backup to keep a copy elsewhere.</p></div>
  </aside>;
}

