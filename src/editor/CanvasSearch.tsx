import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { findTextMatches, type TextMatch } from './search';

const emptyMatches: TextMatch[] = [];

export function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>;
}

export function CanvasSearch({ api, open, onOpen, onClose }: {
  api: ExcalidrawImperativeAPI | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; matches: TextMatch[]; focus: string }>({ query: '', matches: [], focus: '' });
  const searchQuery = query.trim();
  const matches = open && result.query === searchQuery ? result.matches : emptyMatches;
  const index = Math.max(0, matches.findIndex(match => match.key === result.focus));
  const focused = matches[index];

  useLayoutEffect(() => {
    const search = bar.current;
    const editor = search?.parentElement?.querySelector('.canvas-editor');
    if (!open || !search || !editor) return;
    let toolbar: HTMLElement | null = null;
    const matchWidth = () => {
      const width = toolbar?.getBoundingClientRect().width;
      if (width) search.style.setProperty('--search-width', `${width}px`);
    };
    const resize = new ResizeObserver(matchWidth);
    const watchToolbar = () => {
      const next = editor.querySelector<HTMLElement>('.App-toolbar-container > .App-toolbar');
      if (next === toolbar) return;
      if (toolbar) resize.unobserve(toolbar);
      toolbar = next;
      if (toolbar) { resize.observe(toolbar, { box: 'border-box' }); matchWidth(); }
    };
    // Excalidraw replaces the toolbar when switching between desktop and mobile.
    const replacement = new MutationObserver(watchToolbar);
    replacement.observe(editor, { childList: true, subtree: true });
    watchToolbar();
    return () => { resize.disconnect(); replacement.disconnect(); };
  }, [open]);

  useEffect(() => {
    if (open) { input.current?.focus(); input.current?.select(); }
  }, [open]);

  useEffect(() => {
    if (!api) return;
    const show = () => { onOpen(); input.current?.focus(); input.current?.select(); };
    const isFind = (event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
    // Also redirect Excalidraw's command palette entry through its public action API.
    api.registerAction({ name: 'searchMenu', label: 'search.title', viewMode: true, trackEvent: false,
      keyTest: isFind, perform: () => { show(); return false; } });
    const shortcut = (event: KeyboardEvent) => {
      if (!isFind(event) || document.querySelector('dialog[open]')) return;
      event.preventDefault(); event.stopPropagation(); show();
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [api, onOpen]);

  useEffect(() => {
    if (!api || !open) return;
    let signature: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const elements = api.getSceneElements();
      const next = elements.filter(item => item.type === 'text').map(item => `${item.id}:${item.version}:${item.versionNonce}`).join('|');
      if (next === signature) return;
      signature = next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const found = findTextMatches(api.getSceneElements(), searchQuery);
        setResult(previous => ({ query: searchQuery, matches: found,
          focus: previous.query === searchQuery && found.some(match => match.key === previous.focus) ? previous.focus : found[0]?.key ?? '' }));
      }, 120);
    };
    refresh();
    const unsubscribe = api.onChange(refresh);
    // Font loading can change highlight geometry without an edit to the text.
    const fontsLoaded = () => { signature = undefined; refresh(); };
    document.fonts.addEventListener('loadingdone', fontsLoaded);
    return () => { unsubscribe(); clearTimeout(timer); document.fonts.removeEventListener('loadingdone', fontsLoaded); };
  }, [api, open, searchQuery]);

  useEffect(() => {
    api?.updateScene({ appState: { searchMatches: matches.map((match, i) => ({ id: match.element.id, focus: i === index, matchedLines: match.lines })) }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, matches, index]);

  useEffect(() => {
    if (!api || !focused) return;
    // Scroll to the occurrence, including within a long or rotated text block.
    // This rectangle is only a viewport target; it never enters the scene.
    const { element, lines } = focused;
    const left = Math.min(...lines.map(line => line.offsetX)), top = Math.min(...lines.map(line => line.offsetY));
    const width = Math.max(...lines.map(line => line.offsetX + line.width)) - left;
    const height = Math.max(...lines.map(line => line.offsetY + line.height)) - top;
    const dx = left + width / 2 - element.width / 2, dy = top + height / 2 - element.height / 2;
    const x = element.x + element.width / 2 + dx * Math.cos(element.angle) - dy * Math.sin(element.angle) - width / 2;
    const y = element.y + element.height / 2 + dx * Math.sin(element.angle) + dy * Math.cos(element.angle) - height / 2;
    api.scrollToContent({ ...element, type: 'rectangle', x, y, width, height }, { fitToContent: true, maxZoom: 1, animate: false });
    // Updating another element should refresh highlights without moving the viewport.
  }, [api, focused?.key]);

  useEffect(() => () => {
    api?.updateScene({ appState: { searchMatches: [] }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api]);

  function move(direction: number) {
    if (!matches.length) return;
    const next = matches[(index + direction + matches.length) % matches.length];
    setResult(previous => ({ ...previous, focus: next.key }));
    input.current?.focus();
  }

  if (!open) return null;
  return <div ref={bar} id="canvas-search" className="canvas-search" role="search" aria-label="Find in diagram" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Enter' && event.target === input.current && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
  }}>
    <SearchIcon />
    <input ref={input} type="search" aria-label="Find text in diagram" placeholder="Find in diagram…" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
    <span className="canvas-search-count" role="status" aria-live="polite" aria-atomic="true">{searchQuery ? (result.query !== searchQuery ? 'Searching…' : matches.length ? `${index + 1} of ${matches.length}` : 'No matches') : ''}</span>
    <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
    <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => move(1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    <button type="button" aria-label="Close search" title="Close search (Esc)" onClick={onClose}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
  </div>;
}
