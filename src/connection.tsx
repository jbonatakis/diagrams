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
    if (!session.current) throw new Error('Connect this browser first.');
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

  return { status, error, activities, agents, busy, endpoint, connect, disconnect, revoke, forget, refresh };
}

export function AgentConnectionPanel({ connection, onClose }: {
  connection: ReturnType<typeof useAgentConnection>; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const { status, error, agents, busy, endpoint, activities } = connection;
  const connected = status === 'connected';
  const connecting = status === 'connecting' || status === 'reconnecting';
  async function copy() {
    try { await navigator.clipboard.writeText(endpoint); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <aside className="agent-panel" id="agent-panel" aria-label="Agent connection">
    <div className="panel-heading"><div><p className="eyebrow">WORK TOGETHER</p><h2>Your agent, on canvas.</h2></div><button className="icon-button" aria-label="Close agent panel" onClick={onClose}>×</button></div>
    <p className="panel-intro">Approve your agent once. This browser reconnects automatically when you return.</p>
    <div className={`connection-card ${connected ? 'connected' : ''}`}>
      <div className="connection-heading"><span className={`status-dot ${connected ? 'online' : connecting ? 'pending' : ''}`} /><strong data-testid="connection-status">{connected ? 'Connected' : connecting ? 'Connecting…' : 'Not connected'}</strong></div>
      <p>{connected ? 'This browser is ready. Only agents you approve can access its library.' : 'Your diagrams stay available while agent access is disconnected.'}</p>
      {connected || connecting
        ? <button className="secondary-button" onClick={connection.disconnect}>Disconnect</button>
        : <button className="primary-button" onClick={connection.connect}>Connect this canvas</button>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
    <div className="endpoint-section"><div className="section-label"><h3>MCP endpoint</h3><button className="text-button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div><code className="endpoint">{endpoint}</code><p>Add this URL to your agent, then choose Authenticate and approve access in this browser.</p></div>
    <details className="setup-details"><summary>Connect from Codex</summary>
      <p>Add this URL in MCP settings and choose Authenticate. Keep this app open in the browser where you approve access.</p>
      <pre>{`[mcp_servers.diagrams]\nurl = "${endpoint}"`}</pre>
      <p>For an existing connection, remove its old bearer token or Authorization header first.</p>
      <p>From the terminal: <code>codex mcp login diagrams</code></p>
      <a href="https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server" target="_blank" rel="noreferrer">Codex connection guide ↗</a>
    </details>
    <div className="paired-agents">
      <div className="section-label"><h3>Connected agents</h3><button className="text-button" onClick={() => void connection.refresh()}>Refresh</button></div>
      {agents.length === 0 ? <p>No agents have access yet.</p> : <ul>{agents.map(agent =>
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

