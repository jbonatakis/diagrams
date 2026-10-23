import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { formatStorageSize } from '../library/size';
import type { CustomShapes } from './library';

function RemovalStorageEstimate({ selectedBytes, totalBytes }: { selectedBytes: number; totalBytes: number }) {
  const [target, setTarget] = useState<{ host: HTMLElement; all: boolean } | null>(null);
  useLayoutEffect(() => {
    let current: HTMLElement | null = null;
    let host: HTMLElement | null = null;
    const refresh = () => {
      // The native library confirmation has no customization slot. Add just
      // the estimate to its content; native confirmation and deletion stay intact.
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('.excalidraw-modal-container .confirm-dialog')).find(element => {
        const title = element.querySelector('.Dialog__titleContent')?.textContent;
        return title === 'Remove selected items from library' || title === 'Reset library';
      }) ?? null;
      if (dialog === current) return;
      host?.remove(); host = null; current = dialog;
      const content = dialog?.querySelector('.Dialog__content');
      if (content) {
        host = document.createElement('div');
        host.className = 'custom-shape-removal-estimate';
        content.insertBefore(host, content.querySelector('.confirm-dialog-buttons'));
        setTarget({ host, all: dialog!.querySelector('.Dialog__titleContent')?.textContent === 'Reset library' });
      } else setTarget(null);
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target === document.body || record.target instanceof Element && record.target.closest('.excalidraw-modal-container'))) refresh();
    });
    observer.observe(document.body, { subtree: true, childList: true });
    refresh();
    return () => { observer.disconnect(); host?.remove(); };
  }, []);
  return target && createPortal(<p data-testid="custom-shapes-removal-size">Frees ~{formatStorageSize(target.all ? totalBytes : selectedBytes)} in this browser.</p>, target.host);
}

export function CustomShapeStorage({ library }: { library: CustomShapes }) {
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const footer = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const ordered = useMemo(() => [
    ...state.storageSize.items.filter(item => item.status !== 'published'),
    ...state.storageSize.items.filter(item => item.status === 'published'),
  ], [state.storageSize]);

  useLayoutEffect(() => {
    const sidebar = footer.current?.closest('.default-sidebar');
    if (!sidebar) return;
    let emptyHeading: HTMLElement | null = null;
    const refresh = () => {
      // The native headings have no override prop. CSS joins both grids into
      // one list; give its remaining heading real text for assistive technology.
      const content = sidebar.querySelector('.library-menu-items-container__items');
      const heading = content?.querySelector<HTMLElement>('.library-menu-items-container__header:not(.library-menu-items-container__header--excal):not(.custom-shape-empty-heading)');
      if (heading && heading.textContent !== 'Library') {
        heading.textContent = 'Library';
        heading.setAttribute('role', 'heading');
        heading.setAttribute('aria-level', '3');
      }
      // Native Excalidraw omits the entire heading when its library is empty.
      // Keep the same heading row while CSS anchors its menu in that row too.
      if (heading || !content) { emptyHeading?.remove(); emptyHeading = null; }
      else if (!emptyHeading?.isConnected) {
        emptyHeading = document.createElement('div');
        emptyHeading.className = 'library-menu-items-container__header custom-shape-empty-heading';
        emptyHeading.textContent = 'Library';
        emptyHeading.setAttribute('role', 'heading');
        emptyHeading.setAttribute('aria-level', '3');
        content.prepend(emptyHeading);
      }
      // Excalidraw 0.18 keeps library selection private. Read its rendered
      // selection without changing it. Although displayed as one grid, the DOM
      // still orders personal items before published ones, with a possible
      // "add selection" tile at the beginning.
      // Keep skeleton slots in the mapping while thumbnails render in batches.
      const units = Array.from(sidebar.querySelectorAll('.library-menu-items-container__grid > .library-unit'))
        .filter(unit => !unit.querySelector('.library-unit__adder'));
      const next = units.length === ordered.length
        ? ordered.filter((_, index) => units[index].classList.contains('library-unit--selected')).map(item => item.id)
        : [];
      setSelected(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
    };
    const observer = new MutationObserver(records => {
      // Ignore hover styles and our own text updates; watch grid replacements
      // and selection classes, including checkbox and Shift-click selection.
      if (records.some(record => record.type === 'childList'
        ? record.target instanceof Element && !record.target.closest('.custom-shape-storage')
        : record.target instanceof Element && record.target.matches('.library-unit')
          && (record.oldValue ?? '').includes('library-unit--selected') !== record.target.classList.contains('library-unit--selected'))) refresh();
    });
    observer.observe(sidebar, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    refresh();
    return () => { observer.disconnect(); emptyHeading?.remove(); };
  }, [ordered]);

  const selectedIDs = new Set(selected);
  const selectedItems = ordered.filter(item => selectedIDs.has(item.id));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.bytes, 0);
  return <section ref={footer} className="custom-shape-storage" aria-label="Custom shape storage"
    title="Estimated size of these reusable shapes, including their metadata. Browser database overhead and copies placed in diagrams are not included.">
    <p><span>{state.count} {state.count === 1 ? 'shape' : 'shapes'}</span>
      <span data-testid="custom-shapes-storage-total" aria-label={`Estimated storage: ${formatStorageSize(state.storageSize.bytes)}`}>~{formatStorageSize(state.storageSize.bytes)}</span></p>
    {selectedItems.length > 0 && <p className="custom-shape-storage-selection" role="status">
      <span>{selectedItems.length} selected</span><span data-testid="custom-shapes-storage-selected">~{formatStorageSize(selectedBytes)}</span>
    </p>}
    {state.error && <p className="custom-shape-storage-unsaved">Changes not saved</p>}
    <RemovalStorageEstimate selectedBytes={selectedBytes} totalBytes={state.storageSize.bytes} />
  </section>;
}
