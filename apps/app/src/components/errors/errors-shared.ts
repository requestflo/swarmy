/** Small formatters shared by the error-tracking surfaces. */
import type { StatusTone } from '@swarmy/ui';

export type IssueStatus = 'unresolved' | 'resolved' | 'resolved_next_release' | 'ignored';

export const STATUS_FILTERS: { value: IssueStatus | 'all'; label: string }[] = [
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'resolved_next_release', label: 'Next release' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'all', label: 'All' },
];

export function statusLabel(s: IssueStatus): string {
  return s === 'resolved_next_release' ? 'Resolves in next release' : s[0]!.toUpperCase() + s.slice(1);
}

export function levelTone(level: string): StatusTone {
  if (level === 'fatal' || level === 'error') return 'offline';
  if (level === 'warning') return 'warning';
  if (level === 'info' || level === 'debug') return 'progress';
  return 'neutral';
}

/** "3m ago", "2h ago", "5d ago" — or "—" for unset. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Git shas read better short; other release names pass through. */
export function shortRelease(r: string | null | undefined): string {
  if (!r) return '—';
  return /^[0-9a-f]{12,40}$/i.test(r) ? r.slice(0, 7) : r;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Dot fill per `levelTone` (decorative; the level word carries the meaning). */
export const LEVEL_DOT: Record<string, string> = {
  offline: 'bg-status-offline',
  warning: 'bg-status-warning',
  progress: 'bg-status-progress',
  neutral: 'bg-muted-foreground',
  online: 'bg-status-online',
};
