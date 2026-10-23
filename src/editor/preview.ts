import { CommandError } from '../protocol';

export function encodePreview(canvas: HTMLCanvasElement) {
  let dataURL = canvas.toDataURL('image/png');
  if (dataURL.length > 2_000_000) dataURL = canvas.toDataURL('image/jpeg', 0.8);
  if (dataURL.length > 2_000_000) throw new CommandError('preview_too_large', 'Request a smaller maxSize or fewer items for this preview.');
  return { width: canvas.width, height: canvas.height, mimeType: dataURL.slice(5, dataURL.indexOf(';')), data: dataURL.split(',')[1] };
}
