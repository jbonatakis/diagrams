import { useEffect, useId, useRef, useState } from 'react';
import { MainMenu } from '@excalidraw/excalidraw';
import { downloadFile, MAX_LIBRARY_BYTES, type DiagramMeta } from './scene';
import type { Workspace } from './workspace';

type Artifact = { artifactId: string; filename: string; mimeType: string; encoding: 'utf8' | 'base64'; data: string; nextOffset: number | null };

export async function download(workspace: Workspace, library: boolean, format = 'excalidraw') {
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

type DiagramActionsProps = {
  workspace: Workspace; disabled: boolean; act: (fn: () => Promise<unknown>) => Promise<void>;
  onRename: () => void; onDuplicate: () => void; onTrash: () => void;
};
export function DiagramActions({ workspace, disabled, act, onRename, onDuplicate, onTrash }: DiagramActionsProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  function save(format: string) { void act(() => download(workspace, false, format)); }
  return <div className="document-actions" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!open) { setOpen(true); return; }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <button ref={trigger} className="document-menu-toggle" aria-label="Diagram actions" title="Diagram actions" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)} disabled={disabled}>
      <span className="document-menu-label">Actions</span>
      <svg className="document-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      <svg className="document-menu-more" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
    {open && <fieldset ref={menu} id={id} className="document-menu" aria-label="Diagram actions" disabled={disabled}
      onClick={(event) => { if ((event.target as HTMLElement).closest('button')) setOpen(false); }}>
      <button onClick={onRename}>Rename</button>
      <button onClick={onDuplicate}>Duplicate</button>
      <hr />
      <button onClick={() => save('excalidraw')}>Export editable diagram</button>
      <button onClick={() => save('svg')}>Export SVG</button>
      <button onClick={() => save('png')}>Export PNG</button>
      <hr />
      <div className="reset-canvas-action">
        <svg className="reset-canvas-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 7 3.5-4a2 2 0 0 1 3 .5L17 9m2 3 2 4a2 2 0 0 1-2 3h-7m-4 0H5a2 2 0 0 1-2-3l4-7" />
          <path d="m12 8 5 1 1-5m-3 12-3 3 3 3M2 10l5-1 1 5" />
        </svg>
        <MainMenu.DefaultItems.ClearCanvas />
      </div>
      <button className="danger-action" onClick={onTrash}>
        <svg className="document-action-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.333 5.833h13.334M8.333 9.167v5M11.667 9.167v5M4.167 5.833l.833 10c0 .92.746 1.667 1.667 1.667h6.666c.92 0 1.667-.746 1.667-1.667l.833-10M7.5 5.833v-2.5c0-.46.373-.833.833-.833h3.334c.46 0 .833.373.833.833v2.5" />
        </svg>
        Move to trash
      </button>
    </fieldset>}
  </div>;
}

type LibraryProps = {
  state: ReturnType<Workspace['getSnapshot']>; disabled: boolean;
  onClose: () => void; onCreate: () => void; onOpen: (id: string) => void;
  onImport: () => void; onBackup: () => void;
  onManage: (item: DiagramMeta, action: 'duplicate' | 'trash' | 'restore' | 'recover') => void;
};
export function LibraryPanel({ state, disabled, onClose, onCreate, onOpen, onManage, onImport, onBackup }: LibraryProps) {
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState('');
  const items = state.documents.filter((item) => !!item.deletedAt === trash && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <aside id="diagrams-panel" className="library-panel" aria-label="Your diagrams">
    <div className="panel-heading"><div><p className="eyebrow">SAVED HERE</p><h2>Your diagrams</h2></div><button className="icon-button" aria-label="Close diagrams" onClick={onClose}>×</button></div>
    <button className="primary-button" disabled={disabled} onClick={onCreate}>New diagram <span aria-hidden="true">+</span></button>
    <button className="secondary-button" disabled={disabled} onClick={onImport}>Import…</button>
    <input className="library-search" aria-label="Search diagrams" placeholder="Search diagrams…" value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="library-tabs"><button aria-pressed={!trash} onClick={() => setTrash(false)}>Diagrams</button><button aria-pressed={trash} onClick={() => setTrash(true)}>Trash</button></div>
    <ul className="diagram-list">{items.map((item) => <li key={item.id} className={item.id === state.active.id ? 'active' : ''}>
      <button className="diagram-open" disabled={disabled || trash} onClick={() => onOpen(item.id)} aria-current={item.id === state.active.id ? 'true' : undefined}><strong>{item.name}</strong><span>{item.id === state.active.id ? 'Open now' : new Date(item.updatedAt).toLocaleDateString()}</span></button>
      <div className="diagram-actions">{trash ? <button disabled={disabled} onClick={() => onManage(item, 'restore')}>Restore</button> : <><button disabled={disabled} onClick={() => onManage(item, 'duplicate')}>Duplicate</button><button disabled={disabled} onClick={() => onManage(item, 'trash')}>Trash</button></>}
        <button disabled={disabled} title="Restore the previous autosaved version" onClick={() => onManage(item, 'recover')}>Recover previous save</button>
      </div>
    </li>)}</ul>
    {!items.length && <p className="library-empty">{trash ? 'No diagrams in the trash.' : 'No matching diagrams.'}</p>}
    <div className="library-backup">
      <button className="secondary-button" disabled={disabled} onClick={onBackup}>Back up all diagrams</button>
      <p className="library-footnote">Saved on this device in this browser. Back up your diagrams to take them with you. Import accepts diagrams and full backups.</p>
    </div>
  </aside>;
}
