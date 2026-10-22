import { useState } from 'react';
import { downloadFile, MAX_LIBRARY_BYTES, type DiagramMeta } from './scene';
import type { Workspace } from './workspace';

type Artifact = { artifactId: string; filename: string; mimeType: string; encoding: 'utf8' | 'base64'; data: string; nextOffset: number | null };

async function download(workspace: Workspace, library: boolean, format = 'excalidraw') {
  const file = await workspace.run(library ? 'export_library' : 'export_diagram', library ? {} : { diagramId: workspace.active.id, format }) as Artifact;
  try {
    const parts = [file.data];
    let next = file.nextOffset;
    while (next !== null) {
      const chunk = await workspace.run('read_export', { artifactId: file.artifactId, offset: next }) as Artifact;
      parts.push(chunk.data); next = chunk.nextOffset;
    }
    downloadFile({ ...file, data: parts.join('') });
  } finally { await workspace.run('release_transfer', { transferId: file.artifactId }); }
}

export async function importFile(workspace: Workspace, file: File): Promise<{ id?: string; count?: number }> {
  if (file.size > MAX_LIBRARY_BYTES) throw new Error('Choose a file smaller than 64 MB.');
  const data = await file.text();
  let parsed: { type?: string };
  try { parsed = JSON.parse(data); } catch { throw new Error('The file is not valid JSON.'); }
  const kind = parsed?.type === 'diagrams-library' ? 'library' : 'diagram';
  const { uploadId } = await workspace.run('begin_import', { kind }) as { uploadId: string };
  try {
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 16_000, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      await workspace.run('write_import_chunk', { uploadId, offset, data: data.slice(offset, end) }); offset = end;
    }
    const result = await workspace.run(kind === 'library' ? 'import_library' : 'import_diagram', { uploadId, ...(kind === 'diagram' ? { name: file.name.replace(/\.(excalidraw|json)$/i, '').slice(0, 120) || 'Imported diagram' } : {}) }) as { id?: string; imported?: unknown[] };
    return { id: result.id, count: result.imported?.length };
  } finally { await workspace.run('release_transfer', { transferId: uploadId }); }
}

export function FileActions({ workspace, disabled, act, onImport }: { workspace: Workspace; disabled: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; onImport: () => void }) {
  const [open, setOpen] = useState(false);
  function save(library: boolean, format?: string) { setOpen(false); void act(() => download(workspace, library, format)); }
  return <div className="file-actions">
    <button className="library-toggle" aria-expanded={open} onClick={() => setOpen(!open)} disabled={disabled}>Files <span aria-hidden="true">⌄</span></button>
    {open && <><button className="menu-dismiss" aria-label="Close file menu" onClick={() => setOpen(false)} /><div className="file-menu" aria-label="File actions">
      <button onClick={() => { setOpen(false); onImport(); }}>Import diagram or library…</button>
      <hr />
      <button onClick={() => save(false, 'excalidraw')}>Export editable diagram</button>
      <button onClick={() => save(false, 'svg')}>Export SVG</button>
      <button onClick={() => save(false, 'png')}>Export PNG</button>
      <hr /><button onClick={() => save(true)}>Back up library</button>
    </div></>}
  </div>;
}

type LibraryProps = {
  state: ReturnType<Workspace['getSnapshot']>; disabled: boolean;
  onClose: () => void; onCreate: () => void; onOpen: (id: string) => void;
  onManage: (item: DiagramMeta, action: 'duplicate' | 'trash' | 'restore' | 'recover') => void;
};
export function LibraryPanel({ state, disabled, onClose, onCreate, onOpen, onManage }: LibraryProps) {
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState('');
  const items = state.documents.filter((item) => !!item.deletedAt === trash && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <aside className="library-panel" aria-label="Diagram library">
    <div className="panel-heading"><div><p className="eyebrow">SAVED HERE</p><h2>Your diagrams</h2></div><button className="icon-button" aria-label="Close library" onClick={onClose}>×</button></div>
    <button className="primary-button" disabled={disabled} onClick={onCreate}>New diagram <span aria-hidden="true">+</span></button>
    <input className="library-search" aria-label="Search diagrams" placeholder="Search diagrams…" value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="library-tabs"><button aria-pressed={!trash} onClick={() => setTrash(false)}>Diagrams</button><button aria-pressed={trash} onClick={() => setTrash(true)}>Trash</button></div>
    <ul className="diagram-list">{items.map((item) => <li key={item.id} className={item.id === state.active.id ? 'active' : ''}>
      <button className="diagram-open" disabled={disabled || trash} onClick={() => onOpen(item.id)} aria-current={item.id === state.active.id ? 'true' : undefined}><strong>{item.name}</strong><span>{item.id === state.active.id ? 'Open now' : new Date(item.updatedAt).toLocaleDateString()}</span></button>
      <div className="diagram-actions">{trash ? <button disabled={disabled} onClick={() => onManage(item, 'restore')}>Restore</button> : <><button disabled={disabled} onClick={() => onManage(item, 'duplicate')}>Duplicate</button><button disabled={disabled} onClick={() => onManage(item, 'trash')}>Trash</button></>}
        <button disabled={disabled} title="Restore the previous autosaved version" onClick={() => onManage(item, 'recover')}>Recover previous save</button>
      </div>
    </li>)}</ul>
    {!items.length && <p className="library-empty">{trash ? 'No diagrams in the trash.' : 'No matching diagrams.'}</p>}
    <p className="library-footnote">Saved on this device in this browser. Use Files → Back up library to take everything with you.</p>
  </aside>;
}
