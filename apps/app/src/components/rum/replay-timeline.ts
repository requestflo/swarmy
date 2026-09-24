/**
 * Pure: turn one replay (rrweb events + the server's linked spans, logs and
 * errors) into the player's timeline — scrubber ticks and the four side-panel
 * lists. Every time is an offset in ms from the first event, which is exactly
 * what `Replayer.play(offset)` / `pause(offset)` take.
 */
import type { ReplayDetail } from './rum-shared';
import { ms } from './rum-shared';

export type TickKind = 'page' | 'click' | 'net' | 'error';
export interface Tick {
  t: number;
  kind: TickKind;
  label: string;
}

export type RowTone = 'online' | 'offline' | 'warning' | 'progress' | 'neutral';
export interface TimelineRow {
  key: string;
  t: number;
  badge: string;
  tone: RowTone;
  main: string;
  meta: string;
  traceId?: string;
  fingerprint?: string;
}

export interface Timeline {
  start: number;
  total: number;
  ticks: Tick[];
  pages: { t: number; href: string }[];
  requests: TimelineRow[];
  traces: TimelineRow[];
  errors: TimelineRow[];
  logs: TimelineRow[];
}

interface RrEvent {
  type: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

const RR_META = 4;
const RR_INCREMENTAL = 3;
const RR_CUSTOM = 5;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? NaN));
const isErrStatus = (s: string): boolean => /error/i.test(s);

function pathOf(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function asEvents(raw: unknown[]): RrEvent[] {
  return raw.filter(
    (e): e is RrEvent =>
      !!e && typeof e === 'object' && typeof (e as RrEvent).type === 'number' && typeof (e as RrEvent).timestamp === 'number',
  );
}

function statusTone(code: number): RowTone {
  if (!Number.isFinite(code) || code === 0) return 'neutral';
  if (code >= 500) return 'offline';
  if (code >= 400) return 'warning';
  return 'online';
}

export function buildTimeline(d: Pick<ReplayDetail, 'events' | 'requests' | 'logs' | 'errors'>): Timeline {
  const events = asEvents(d.events);
  const start = events[0]?.timestamp ?? 0;
  const end = events.at(-1)?.timestamp ?? start;
  const at = (ts: number): number => Math.min(Math.max(0, ts - start), end - start);
  const ticks: Tick[] = [];
  const pages: Timeline['pages'] = [];
  const requests: TimelineRow[] = [];
  const errors: TimelineRow[] = [];
  const clientTime = new Map<string, number>();

  // The root-most span per trace: the longest one is the request as the server saw it.
  const spanByTrace = new Map<string, ReplayDetail['requests'][number]>();
  for (const s of d.requests) {
    const cur = spanByTrace.get(s.traceId);
    if (!cur || s.durationMs > cur.durationMs) spanByTrace.set(s.traceId, s);
  }

  events.forEach((e, i) => {
    const t = at(e.timestamp);
    const data = e.data ?? {};
    if (e.type === RR_META && typeof data.href === 'string') {
      pages.push({ t, href: data.href });
      ticks.push({ t, kind: 'page', label: `Page ${pathOf(data.href)}` });
    } else if (e.type === RR_INCREMENTAL && data.source === 2 && data.type === 2) {
      ticks.push({ t, kind: 'click', label: 'Click' });
    } else if (e.type === RR_CUSTOM) {
      const p = (data.payload ?? {}) as Record<string, unknown>;
      if (data.tag === 'swarmy.navigation') {
        const href = str(p.url);
        pages.push({ t, href });
        ticks.push({ t, kind: 'page', label: `Page ${pathOf(href)}` });
        if (p.traceId) clientTime.set(str(p.traceId), t);
      } else if (data.tag === 'swarmy.request') {
        const traceId = str(p.traceId);
        const span = traceId ? spanByTrace.get(traceId) : undefined;
        const code = num(span?.httpStatus || p.status);
        const path = pathOf(str(p.url));
        if (traceId) clientTime.set(traceId, t);
        ticks.push({ t, kind: code >= 500 ? 'error' : 'net', label: `${str(p.method) || 'GET'} ${path}` });
        requests.push({
          key: `r${i}`,
          t,
          badge: Number.isFinite(code) && code > 0 ? String(code) : '—',
          tone: statusTone(code),
          main: `${str(p.method) || 'GET'} ${path}`,
          meta: span ? `${ms(span.durationMs)} · ${span.service}` : Number.isFinite(num(p.dur)) ? ms(num(p.dur)) : '',
          traceId: traceId || undefined,
        });
      } else if (data.tag === 'swarmy.error') {
        const msg = str(p.message) || 'Error';
        ticks.push({ t, kind: 'error', label: msg });
        errors.push({ key: `e${i}`, t, badge: 'browser', tone: 'offline', main: msg, meta: str(p.source || p.filename) });
      }
    }
  });

  for (const [i, e] of d.errors.entries()) {
    const ts = num(e.ts_ms);
    const t = Number.isFinite(ts) ? at(ts) : 0;
    const title = str(e.title) || [str(e.exc_type), str(e.exc_value)].filter(Boolean).join(': ') || 'Server error';
    errors.push({
      key: `s${i}`,
      t,
      badge: 'server',
      tone: 'offline',
      main: title,
      meta: str(e.culprit),
      traceId: str(e.trace_id) || undefined,
      fingerprint: str(e.fingerprint) || undefined,
    });
    ticks.push({ t, kind: 'error', label: title });
  }

  const traces: TimelineRow[] = [];
  for (const [traceId, root] of spanByTrace) {
    const spans = d.requests.filter((s) => s.traceId === traceId);
    const services = [...new Set(spans.map((s) => s.service))].join(' → ');
    const failed = spans.some((s) => isErrStatus(s.status)) || num(root.httpStatus) >= 500;
    traces.push({
      key: traceId,
      t: clientTime.get(traceId) ?? at(root.startMs),
      badge: failed ? 'error' : 'ok',
      tone: failed ? 'offline' : 'progress',
      main: `${services} · ${spans.length} span${spans.length === 1 ? '' : 's'}`,
      meta: ms(root.durationMs),
      traceId,
    });
  }

  const logs: TimelineRow[] = d.logs.map((l, i) => {
    const sev = l.severity.toLowerCase();
    return {
      key: `l${i}`,
      t: at(l.tsMs),
      badge: sev || 'log',
      tone: /err|fatal|crit/.test(sev) ? 'offline' : /warn/.test(sev) ? 'warning' : 'neutral',
      main: l.body,
      meta: l.service,
      traceId: l.traceId || undefined,
    };
  });

  const byT = (a: { t: number }, b: { t: number }): number => a.t - b.t;
  return {
    start,
    total: end - start,
    ticks: ticks.sort(byT),
    pages,
    requests,
    traces: traces.sort(byT),
    errors: errors.sort(byT),
    logs: logs.sort(byT),
  };
}

/** The last item at or before `t` (the "now" row / current page). */
export function lastAt<T extends { t: number }>(items: T[], t: number): T | undefined {
  let found: T | undefined;
  for (const it of items) {
    if (it.t <= t) found = it;
    else break;
  }
  return found;
}
