import type { StorageSize } from './scene';

const numberFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function estimatedStorageBytes(size: StorageSize | undefined) {
  return size ? size.sceneBytes + size.recoveryBytes + size.metadataBytes : 0;
}

export function formatStorageSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  const unit = bytes < 1_000_000 ? 'KB' : bytes < 1_000_000_000 ? 'MB' : 'GB';
  const amount = bytes / (unit === 'KB' ? 1000 : unit === 'MB' ? 1_000_000 : 1_000_000_000);
  return `${numberFormat.format(amount)} ${unit}`;
}
