import * as React from 'react';
import type { JobRunStatusView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';

const TONE: Record<JobRunStatusView, StatusTone> = {
  running: 'progress',
  succeeded: 'online',
  failed: 'offline',
  timeout: 'warning',
};

const LABEL: Record<JobRunStatusView, string> = {
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timeout: 'timed out',
};

/** Run status chip, driven by the cluster status tokens. */
export function JobRunChip({ status }: { status: JobRunStatusView }): React.JSX.Element {
  return <StatusBadge tone={TONE[status]} label={LABEL[status]} />;
}

/** "in 2h" / "in 3m" — countdown to an upcoming run. */
export function untilTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'any moment';
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Run duration "4s" / "2m 10s" from start/finish stamps. */
export function runDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '…';
  const s = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
