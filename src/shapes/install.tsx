import { useEffect, useState } from 'react';
import type { LibraryItems } from '@excalidraw/excalidraw/types';
import type { Workspace } from '../library/workspace';
import { MAX_SHAPE_BYTES, parseShapeFile } from './library';

const channelName = 'diagrams-custom-shapes';
const pendingKey = 'diagrams-pending-shape-install';
export const shapeLibraryReturnURL = () => `${location.origin}${location.pathname}?install=custom-shapes`;
export const isShapeLibraryReturn = () => new URLSearchParams(location.search).get('install') === 'custom-shapes'
  || new URLSearchParams(location.hash.slice(1)).has('addLibrary') || new URLSearchParams(location.search).has('addLibrary');

export function validateShapeURL(value: string) {
  if (value.length > 8192) throw new Error('The library URL is too long.');
  const url = new URL(value);
  const official = url.hostname === 'excalidraw.com' || url.hostname.endsWith('.excalidraw.com');
  const github = url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/excalidraw/excalidraw-libraries/');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(official || github)) {
    throw new Error('Install from the Excalidraw catalog, or download an .excalidrawlib file and import it through Custom Shapes.');
  }
  return url.href;
}
function installURL() {
  const value = new URLSearchParams(location.hash.slice(1)).get('addLibrary') || new URLSearchParams(location.search).get('addLibrary');
  if (!value) throw new Error('This link does not contain a shape library.');
  return validateShapeURL(value.startsWith('https:') ? value : decodeURIComponent(value));
}
function clearInstallURL() {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  hash.delete('addLibrary'); hash.delete('token'); url.hash = hash.toString();
  url.searchParams.delete('addLibrary'); url.searchParams.delete('token'); url.searchParams.delete('install');
  history.replaceState(null, '', url);
}

/** This lightweight return page never acquires a persistent workspace lock or opens MCP. */
export function CustomShapeReturn() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ sent: false, error: '' });
  useEffect(() => {
    setState({ sent: false, error: '' });
    let url: string;
    try { url = installURL(); } catch (error) { setState({ sent: false, error: (error as Error).message }); return; }
    const channel = new BroadcastChannel(channelName);
    const id = crypto.randomUUID();
    let stopped = false;
    const offer = () => channel.postMessage({ type: 'install', id, url });
    const interval = setInterval(offer, 1000);
    const timeout = setTimeout(() => {
      stopped = true; clearInterval(interval);
      setState({ sent: false, error: 'Could not reach your open Diagrams tab. Bring it to the foreground, then retry here.' });
    }, 15_000);
    channel.onmessage = event => {
      if (stopped || event.data?.type !== 'received' || event.data.id !== id) return;
      stopped = true; clearInterval(interval); clearTimeout(timeout);
      setState({ sent: true, error: event.data.error ?? '' });
      if (!event.data.error) clearInstallURL();
    };
    offer();
    // If there is no existing workspace, return to the app with an ephemeral
    // install request. The actual workspace takes its normal lock after navigation.
    void navigator.locks.request('diagrams-library-writer', { ifAvailable: true }, lock => {
      if (!lock || stopped) return;
      sessionStorage.setItem(pendingKey, url);
      location.replace(location.pathname);
    }).catch(error => { if (!stopped) setState({ sent: false, error: (error as Error).message }); });
    return () => { stopped = true; clearInterval(interval); clearTimeout(timeout); channel.close(); };
  }, [attempt]);
  return <main className="loading-screen">
    <h1>{state.error ? 'Could not open this shape library' : state.sent ? 'Ready in your Diagrams tab' : 'Opening shape library…'}</h1>
    <p>{state.error || (state.sent ? 'Return to your open Diagrams tab to review and add the shapes. You can close this tab.' : 'Finding your open canvas.')}</p>
    {state.error && <button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
  </main>;
}

async function downloadLibrary(url: string, signal: AbortSignal) {
  const response = await fetch(validateShapeURL(url), { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body) throw new Error(`Could not download this shape library (${response.status}).`);
  validateShapeURL(response.url);
  if (Number(response.headers.get('content-length')) > MAX_SHAPE_BYTES) throw new Error('Choose a shape library smaller than 16 MB.');
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SHAPE_BYTES) throw new Error('Choose a shape library smaller than 16 MB.');
      chunks.push(value.slice().buffer);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return parseShapeFile(new Blob(chunks, { type: 'application/json' }));
}

type Install = { id: string; url: string; items?: LibraryItems; error?: string; busy?: boolean };
export function CustomShapeInstaller({ workspace, onNotice }: { workspace: Workspace; onNotice: (message: string) => void }) {
  const [queue, setQueue] = useState<Install[]>([]);
  const [downloadAttempt, setDownloadAttempt] = useState(0);
  const request = queue[0];
  useEffect(() => {
    const channel = new BroadcastChannel(channelName);
    const seen = new Set<string>();
    const enqueue = (id: string, value: string) => {
      if (seen.has(id)) return;
      const url = validateShapeURL(value);
      if (seen.size >= 100) seen.delete(seen.values().next().value!);
      seen.add(id);
      setQueue(previous => previous.some(item => item.url === url) ? previous : [...previous, { id, url }]);
    };
    channel.onmessage = event => {
      const data = event.data;
      if (data?.type !== 'install' || typeof data.id !== 'string' || data.id.length > 100 || typeof data.url !== 'string') return;
      try { enqueue(data.id, data.url); channel.postMessage({ type: 'received', id: data.id }); }
      catch (error) { channel.postMessage({ type: 'received', id: data.id, error: (error as Error).message }); }
    };
    const pending = sessionStorage.getItem(pendingKey);
    if (pending) {
      sessionStorage.removeItem(pendingKey);
      try { enqueue(crypto.randomUUID(), pending); } catch (error) { onNotice((error as Error).message); }
    }
    const hashChange = () => {
      if (!new URLSearchParams(location.hash.slice(1)).has('addLibrary')) return;
      try { enqueue(crypto.randomUUID(), installURL()); }
      catch (error) { onNotice((error as Error).message); }
      clearInstallURL();
    };
    window.addEventListener('hashchange', hashChange);
    return () => { channel.close(); window.removeEventListener('hashchange', hashChange); };
  }, [workspace, onNotice]);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setQueue(previous => previous.map(item => item.id === request.id ? { ...item, error: undefined } : item));
    void downloadLibrary(request.url, controller.signal).then(items => {
      if (!disposed) setQueue(previous => previous.map(item => item.id === request.id ? { ...item, items } : item));
    }).catch(error => {
      if (!disposed) setQueue(previous => previous.map(item => item.id === request.id ? { ...item, error: controller.signal.aborted ? 'The download timed out. Try again.' : (error as Error).message } : item));
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [request?.id, downloadAttempt]);

  if (!request) return null;
  const dismiss = () => setQueue(previous => previous.filter(item => item.id !== request.id));
  const install = async () => {
    if (!request.items) return;
    setQueue(previous => previous.map(item => item.id === request.id ? { ...item, busy: true, error: undefined } : item));
    try {
      const result = await workspace.importCustomShapes(request.items);
      onNotice(result.added ? `Added ${result.added} custom shapes.` : 'These custom shapes are already installed.');
      dismiss();
    } catch (error) {
      setQueue(previous => previous.map(item => item.id === request.id ? { ...item, busy: false, error: (error as Error).message } : item));
    }
  };
  return <section className="shape-install-notice" aria-label="Install custom shapes">
    <div><strong>{request.items ? `Add ${request.items.length} custom shapes?` : request.error ? 'Could not load shape library' : 'Loading shape library…'}</strong>
      <p>{request.error ? <span role="alert">{request.error}</span> : `From ${new URL(request.url).hostname}. Saved only in this browser.`}</p></div>
    {request.items && <button className="secondary-button" disabled={request.busy} onClick={() => void install()}>{request.busy ? 'Adding…' : 'Add shapes'}</button>}
    {!request.items && request.error && <button className="secondary-button" onClick={() => setDownloadAttempt(value => value + 1)}>Retry download</button>}
    <button className="secondary-button" disabled={request.busy} onClick={dismiss}>Cancel</button>
  </section>;
}
