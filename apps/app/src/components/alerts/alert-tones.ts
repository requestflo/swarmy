import type { AlertSeverityView } from '@swarmy/core';
import type { StatusTone } from '@swarmy/ui';

/** Severity → Hot Signal status tone (tokens only, never raw palette). */
export const SEVERITY_TONE: Record<AlertSeverityView, StatusTone> = {
  info: 'progress',
  warning: 'warning',
  critical: 'offline',
};

/** Compact human duration for a rule's for-seconds gate. */
export function forDuration(seconds: number): string {
  if (seconds <= 0) return 'immediately';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
