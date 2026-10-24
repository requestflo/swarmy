/**
 * Plain words for the offline-bundle upload (Settings › Platform › Import
 * release). Pure, so the dialog and its tests agree.
 */

export interface BundleProgressLike {
  phase: 'sending' | 'receiving' | 'loading' | 'done' | 'failed';
  size: number;
  received: number;
  version?: string | null;
  total?: number | null;
  done?: number | null;
  current?: string | null;
  error?: string | null;
}

/** 1.2 GB / 340 MB / 12 KB. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** 0–100 for the bar: sending is the first half, loading images the second. */
export function bundlePercent(p: BundleProgressLike): number {
  if (p.phase === 'done') return 100;
  const sent = p.size > 0 ? p.received / p.size : 0;
  if (p.phase === 'sending' || p.phase === 'receiving') return Math.round(sent * 50);
  const loaded = p.total ? (p.done ?? 0) / p.total : 0;
  return 50 + Math.round(loaded * 50);
}

/** The one sentence under the bar. */
export function bundleWords(p: BundleProgressLike): string {
  switch (p.phase) {
    case 'sending':
    case 'receiving':
      return `Sending the bundle: ${sizeWords(p.received)} of ${sizeWords(p.size)}`;
    case 'loading':
      if (!p.total) return 'Checking the signature…';
      return `Copying swarmy ${p.version ?? ''} into your cluster: ${p.done ?? 0} of ${p.total} images${p.current ? ` (${p.current})` : ''}`.replace('  ', ' ');
    case 'done':
      return `swarmy ${p.version ?? ''} is verified and in your cluster. Upgrade is ready above.`.replace('  ', ' ');
    case 'failed':
      return `Nothing was upgraded: ${p.error ?? 'the bundle could not be loaded'}`;
  }
}
