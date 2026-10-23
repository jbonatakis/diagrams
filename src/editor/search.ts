import { FONT_FAMILY } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { AppState } from '@excalidraw/excalidraw/types';

export type TextMatch = {
  key: string;
  element: ExcalidrawTextElement;
  lines: AppState['searchMatches'][number]['matchedLines'];
};

const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ');
const fontNames = new Map(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));

/** Match original text, then locate each occurrence in its rendered (possibly wrapped) lines. */
export function findTextMatches(elements: readonly ExcalidrawElement[], query: string): TextMatch[] {
  if (!query.trim()) return [];
  const pattern = new RegExp(normalize(query.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const context = document.createElement('canvas').getContext('2d')!;
  const matches: TextMatch[] = [];
  const texts = elements.filter((item): item is ExcalidrawTextElement => item.type === 'text' && !item.isDeleted)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  for (const element of texts) {
    const original = normalize(element.originalText);
    const occurrences = [...original.matchAll(pattern)];
    if (!occurrences.length) continue;
    const family = fontNames.get(element.fontFamily) ?? 'sans-serif';
    context.font = `${element.fontSize}px "${family}", ${family === 'Excalifont' ? 'Xiaolai, ' : ''}"Segoe UI Emoji", sans-serif`;
    const width = (text: string) => context.measureText(text).width;
    let cursor = 0;
    const lines = normalize(element.text).split('\n').map((text, row) => {
      const start = original.indexOf(text, cursor);
      cursor = (start < 0 ? cursor : start) + text.length;
      const lineWidth = width(text);
      const left = element.textAlign === 'center' ? (element.width - lineWidth) / 2
        : element.textAlign === 'right' ? element.width - lineWidth : 0;
      return { text, start, row, left };
    });
    for (const occurrence of occurrences) {
      const start = occurrence.index;
      const end = start + occurrence[0].length;
      const matchedLines: TextMatch['lines'] = [];
      for (const line of lines) {
        if (line.start < 0) continue;
        const from = Math.max(start, line.start) - line.start;
        const to = Math.min(end, line.start + line.text.length) - line.start;
        if (from >= to) continue;
        const prefix = width(line.text.slice(0, from));
        matchedLines.push({ offsetX: line.left + prefix, offsetY: line.row * element.fontSize * element.lineHeight,
          width: width(line.text.slice(0, to)) - prefix, height: element.fontSize * element.lineHeight });
      }
      if (matchedLines.length) matches.push({ key: `${element.id}:${start}`, element, lines: matchedLines });
    }
  }
  return matches;
}
