/** Byte/count formatting for the buckets surface (numbers are heroes — keep them tight). */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${UNITS[u]}`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** GB → bytes for the quota editor (input is in GB for humans). */
export function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 * 1024 * 1024);
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}
