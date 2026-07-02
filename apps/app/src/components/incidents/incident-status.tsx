import * as React from 'react';
import type { IncidentSeverityView, IncidentStatusView } from '@swarmy/core';
import { StatusBadge, type StatusTone, cn } from '@swarmy/ui';

const SEVERITY_TONE: Record<IncidentSeverityView, StatusTone> = {
  critical: 'offline',
  major: 'warning',
  minor: 'neutral',
};

/** Severity chip — crimson critical, amber major, quiet minor. */
export function SeverityChip({
  severity,
  className,
}: {
  severity: IncidentSeverityView;
  className?: string;
}): React.JSX.Element {
  return <StatusBadge tone={SEVERITY_TONE[severity]} label={severity} className={className} />;
}

/** Status chip — an open incident demands attention; resolved reads green. */
export function IncidentStatusChip({
  status,
  className,
}: {
  status: IncidentStatusView;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'mono-label inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        status === 'open'
          ? 'bg-status-offline/12 text-status-offline'
          : 'bg-status-online/12 text-status-online',
        className,
      )}
    >
      {status === 'open' ? <span className="pulse-dot" /> : null}
      {status}
    </span>
  );
}

/** "3m ago" — matches the idiom used across list surfaces. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "4m 12s" / "1h 05m" / "2d 3h" — incident duration from seconds. */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ${String(sec % 60).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "14:01:12" — the timeline's mono clock (local time). */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
