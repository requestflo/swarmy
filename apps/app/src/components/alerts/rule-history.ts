import type { AlertEventView } from '@swarmy/core';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Fire {
  start: number;
  /** null = still firing. */
  end: number | null;
  resource: string;
  critical: boolean;
}

export interface WeekHistory {
  fires: Fire[];
  /** The event page didn't reach back a full week, so the count is a floor. */
  partial: boolean;
}

/**
 * What a signal really fired in the last 7 days, from the alert event feed
 * (the controller's own fired history — never a synthetic series).
 */
export function weekHistory(events: AlertEventView[], signal: string, now: number, pageFull: boolean): WeekHistory {
  const from = now - WEEK_MS;
  const fires = events
    .filter((e) => e.signal === signal && Date.parse(e.firedAt) >= from)
    .map((e) => ({
      start: Date.parse(e.firedAt),
      end: e.status === 'firing' ? null : Date.parse(e.resolvedAt ?? e.firedAt),
      resource: e.resource,
      critical: e.severity === 'critical',
    }))
    .sort((a, b) => a.start - b.start);
  const oldest = events.reduce((m, e) => Math.min(m, Date.parse(e.firedAt)), now);
  return { fires, partial: pageFull && oldest > from };
}

/** "18 min" · "2 h 5 min" · "40 s". */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
