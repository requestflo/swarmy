import type { PublicComponentStatus } from '@swarmy/core';
import type { StatusTone } from '@swarmy/ui';

/** Public status → the Hot Signal status-token vocabulary. */
export const PUBLIC_STATUS_TONE: Record<PublicComponentStatus, StatusTone> = {
  up: 'online',
  degraded: 'warning',
  down: 'offline',
  unknown: 'neutral',
};

/** Component-row wording. */
export const PUBLIC_STATUS_LABEL: Record<PublicComponentStatus, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'No data',
};

/** Page-banner wording. */
export const OVERALL_LABEL: Record<PublicComponentStatus, string> = {
  up: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Major outage',
  unknown: 'No status data yet',
};

/** Banner surface classes per overall status (status tokens only). */
export const OVERALL_CLASSES: Record<PublicComponentStatus, string> = {
  up: 'bg-status-online/12 text-status-online',
  degraded: 'bg-status-warning/12 text-status-warning',
  down: 'bg-status-offline/12 text-status-offline',
  unknown: 'bg-status-idle/12 text-status-idle',
};

/** One uptime bar's fill for a day's pct (null = no data). */
export function uptimeBarClass(pct: number | null): string {
  if (pct === null) return 'bg-muted';
  if (pct >= 99.5) return 'bg-status-online';
  if (pct >= 90) return 'bg-status-warning';
  return 'bg-status-offline';
}
