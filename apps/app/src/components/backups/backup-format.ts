import type { StatusTone } from '@swarmy/ui';

/** "1.7 GB" from a byte count (string BigInt from the API, or number). */
export function fmtBytes(n: string | number | null): string {
  if (n == null || n === '') return '—';
  let v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "35m ago" / "just now" for ISO timestamps (past). */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "in 5h" / "due now" for ISO timestamps (future). */
export function untilTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Snapshot status → cluster-vocabulary status tone. */
export const SNAPSHOT_TONE: Record<string, StatusTone> = {
  SUCCEEDED: 'online',
  RUNNING: 'progress',
  FAILED: 'offline',
  PRUNED: 'neutral',
};
