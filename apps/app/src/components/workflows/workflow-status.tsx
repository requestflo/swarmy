import * as React from 'react';
import type { WorkflowRunStatusView, WorkflowStepKind, WorkflowStepStatusView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';

/** Status vocab for the workflows surface — tones only via `--status-*`. */

export const RUN_STATUS_META: Record<WorkflowRunStatusView, { tone: StatusTone; label: string }> = {
  running: { tone: 'progress', label: 'running' },
  'waiting-approval': { tone: 'warning', label: 'needs approval' },
  succeeded: { tone: 'online', label: 'succeeded' },
  failed: { tone: 'offline', label: 'failed' },
  cancelled: { tone: 'neutral', label: 'cancelled' },
};

export const STEP_STATUS_META: Record<WorkflowStepStatusView, { tone: StatusTone; label: string }> = {
  pending: { tone: 'neutral', label: 'pending' },
  running: { tone: 'progress', label: 'running' },
  waiting: { tone: 'warning', label: 'waiting' },
  succeeded: { tone: 'online', label: 'succeeded' },
  failed: { tone: 'offline', label: 'failed' },
  cancelled: { tone: 'neutral', label: 'cancelled' },
};

export const STEP_KIND_LABEL: Record<WorkflowStepKind, string> = {
  container: 'Container',
  'service-exec': 'Service exec',
  webhook: 'Webhook',
  approval: 'Approval',
  delay: 'Delay',
};

export function RunStatusChip({ status }: { status: WorkflowRunStatusView }): React.JSX.Element {
  const meta = RUN_STATUS_META[status];
  return <StatusBadge tone={meta.tone} label={meta.label} />;
}

/** "4m 12s" / "1h 03m" / "12s" — for run + step durations. */
export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
