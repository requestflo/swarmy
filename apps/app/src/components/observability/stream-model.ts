import { logSeverityFromNumber, type LogRowView } from '@swarmy/core';

/** The four level words the stream shows (fatal folds into error, trace into debug). */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LevelFilter = 'all' | LogLevel;
export const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function levelOf(severityNumber: number): LogLevel {
  const s = logSeverityFromNumber(severityNumber);
  if (s === 'fatal' || s === 'error') return 'error';
  if (s === 'warn') return 'warn';
  if (s === 'debug' || s === 'trace') return 'debug';
  return 'info';
}

export type LevelCounts = Record<LevelFilter, number>;

/** How many lines at each level (and in all). */
export function levelCounts(rows: Pick<LogRowView, 'severity_number'>[]): LevelCounts {
  const out: LevelCounts = { all: rows.length, error: 0, warn: 0, info: 0, debug: 0 };
  for (const r of rows) out[levelOf(r.severity_number)] += 1;
  return out;
}

export function byLevel<T extends Pick<LogRowView, 'severity_number'>>(rows: T[], level: LevelFilter): T[] {
  return level === 'all' ? rows : rows.filter((r) => levelOf(r.severity_number) === level);
}

/** A stable key for one line (the same instant can carry several lines). */
export function lineKey(r: Pick<LogRowView, 'ts_nano' | 'span_id' | 'service_name' | 'body'>): string {
  return `${r.ts_nano}|${r.service_name}|${r.span_id}|${r.body.length}`;
}

/** `10:41:44.102` in the viewer's clock, from the nanosecond timestamp. */
export function lineTime(tsNano: string): string {
  const d = new Date(Number(tsNano.slice(0, -6) || '0'));
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Split a newest-first feed at the pause point: lines at or before `cutoff`
 * are shown, newer ones are counted as "N new lines". No cutoff = live.
 */
export function splitAtCutoff<T extends Pick<LogRowView, 'ts_nano'>>(rows: T[], cutoff: string | null): { shown: T[]; fresh: number } {
  if (cutoff === null) return { shown: rows, fresh: 0 };
  const c = BigInt(cutoff);
  let fresh = 0;
  const shown: T[] = [];
  for (const r of rows) {
    if (BigInt(r.ts_nano) > c) fresh += 1;
    else shown.push(r);
  }
  return { shown, fresh };
}

/** Collapse the variable parts of a message (ids, numbers, quoted values) so repeats group. */
export function fingerprint(body: string): string {
  return body
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b(?=[a-z_]*\d)[a-z0-9_]{6,}\b/g, '<id>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ErrorGroup {
  key: string;
  /** The newest line's text, as the group's label. */
  message: string;
  part: string;
  count: number;
  firstNano: string;
  lastNano: string;
  /** The newest line carrying a trace, if any. */
  traceId: string | null;
}

/** Error lines grouped by message fingerprint + part, most frequent first. */
export function groupErrors(rows: LogRowView[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const r of rows) {
    if (levelOf(r.severity_number) !== 'error') continue;
    const key = `${r.service_name}|${fingerprint(r.body)}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, message: r.body, part: r.service_name, count: 1, firstNano: r.ts_nano, lastNano: r.ts_nano, traceId: r.trace_id || null });
      continue;
    }
    g.count += 1;
    if (BigInt(r.ts_nano) > BigInt(g.lastNano)) {
      g.lastNano = r.ts_nano;
      g.message = r.body;
      if (r.trace_id) g.traceId = r.trace_id;
    } else if (!g.traceId && r.trace_id) g.traceId = r.trace_id;
    if (BigInt(r.ts_nano) < BigInt(g.firstNano)) g.firstNano = r.ts_nano;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (BigInt(b.lastNano) > BigInt(a.lastNano) ? 1 : -1));
}

export interface IssueLike {
  fingerprint: string;
  title: string;
  culprit?: string | null;
}

/**
 * The error-tracking issue a log group is about, if error tracking has one:
 * a dotted call name from the log line (`stripe.paymentIntents.create`)
 * appears in the issue title, and the issue's culprit is in the same part.
 */
export function matchIssue(group: Pick<ErrorGroup, 'message' | 'part'>, issues: IssueLike[]): string | null {
  const tokens = (group.message.toLowerCase().match(/[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+/g) ?? []).filter((t) => t.length >= 8);
  if (tokens.length === 0) return null;
  const hit = issues.find((i) => {
    const title = i.title.toLowerCase();
    const samePart = !i.culprit || i.culprit.toLowerCase().startsWith(`${group.part.toLowerCase()}/`);
    return samePart && tokens.some((t) => title.includes(t));
  });
  return hit?.fingerprint ?? null;
}

/** The parts the error lines came from, most errors first. */
export function errorParts(rows: LogRowView[]): string[] {
  const n = new Map<string, number>();
  for (const r of rows) if (levelOf(r.severity_number) === 'error') n.set(r.service_name, (n.get(r.service_name) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}
