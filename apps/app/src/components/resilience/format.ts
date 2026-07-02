import type { ResilienceDrillKind, ResilienceSeverity } from '@swarmy/core';

/** "2 days ago" / "just now" for ISO timestamps. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Compact duration: "5m", "8m 20s", "41s". */
export function formatDurationMs(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min}m ${rest}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/** Compact duration from seconds (RPO display). */
export function formatDurationSec(sec: number): string {
  return formatDurationMs(sec * 1000);
}

export const DRILL_TITLES: Record<ResilienceDrillKind, string> = {
  restore: 'Restore drill',
  failover: 'Failover drill',
  'backup-verify': 'Backup verify',
};

export const DRILL_BLURBS: Record<ResilienceDrillKind, string> = {
  restore:
    'Clones your latest DB backup into a throwaway cluster, runs SELECT 1, then destroys the clone.',
  failover: 'Promotes a standby, verifies it takes over, then rejoins it to the cluster.',
  'backup-verify': 'Runs restic check against your backup destination to prove the repo is intact.',
};

/** Hot Signal status-token classes per severity. */
export const SEVERITY_TONE: Record<ResilienceSeverity, { text: string; bg: string; label: string }> =
  {
    crit: { text: 'text-status-offline', bg: 'bg-status-offline/12', label: 'Critical' },
    warn: { text: 'text-status-warning', bg: 'bg-status-warning/12', label: 'Warning' },
    info: { text: 'text-status-progress', bg: 'bg-status-progress/12', label: 'Info' },
  };
