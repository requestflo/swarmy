/** Types + small formatters shared by the web analytics and session replay surfaces. */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';

type Rum = TRPCOptionsProxy<AppRouter>['rum'];

export type RumSettingsView = inferOutput<Rum['getSettings']>;
export type RumSettings = RumSettingsView['settings'];
export type RumRoute = RumSettingsView['routes'][number];
export type AnalyticsView = inferOutput<Rum['analytics']>;
export type Breakdown = AnalyticsView['pages'][number];
export type SignedInUser = AnalyticsView['users'][number];
export type ReplaySession = inferOutput<Rum['replays']>['sessions'][number];
export type ReplayDetail = inferOutput<Rum['replay']>;
export type Footprint = inferOutput<Rum['footprint']>;

/** Mirrors `RUM_SAMPLE_CHOICES` / `RUM_RETENTION_CHOICES` in @swarmy/rum. */
export const SAMPLE_CHOICES = [0, 0.01, 0.05, 0.1, 0.25, 1] as const;
export const RETENTION_CHOICES = [7, 14, 30, 90] as const;

export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** 161 → "2m 41s"; 42 → "42s". */
export function visitLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Player clock: 94_000 → "1:34". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

/** ClickHouse returns "2026-09-24 10:41:00.000" (UTC, no zone) — parse it as UTC. */
export function parseTs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  return Date.parse(iso);
}

export function timeAgo(ts: string | null | undefined, now = Date.now()): string {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return '—';
  const m = Math.round(Math.max(0, now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Wall-clock "10:41" for a session start. */
export function hhmm(ts: string): string {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Anonymous sessions read as "anon · 7f2a"; identified ones show the user id. */
export function sessionWho(s: { userId: string; sessionId: string }): string {
  return s.userId || `anon · ${s.sessionId.slice(0, 4)}`;
}

let regionNames: Intl.DisplayNames | null | undefined;
/** "GB" → "United Kingdom" (falls back to the code). */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** What every settings card takes: the current settings, a patch-saver, and admin-ness. */
export interface SettingsCardProps {
  settings: RumSettings;
  onChange: (patch: Partial<RumSettings>) => void;
  disabled: boolean;
}
