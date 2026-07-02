import * as React from 'react';
import type { ReleaseStatusView } from '@swarmy/core';
import { StatusBadge, type StatusTone } from '@swarmy/ui';

const TONE: Record<ReleaseStatusView, StatusTone> = {
  deploying: 'progress',
  healthy: 'online',
  failed: 'offline',
  'rolled-back': 'warning',
  superseded: 'neutral',
};

const LABEL: Record<ReleaseStatusView, string> = {
  deploying: 'deploying',
  healthy: 'healthy',
  failed: 'failed',
  'rolled-back': 'rolled back',
  superseded: 'superseded',
};

/** Release status chip, driven by the cluster status tokens. */
export function ReleaseStatusChip({ status }: { status: ReleaseStatusView }): React.JSX.Element {
  return <StatusBadge tone={TONE[status]} label={LABEL[status]} />;
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
