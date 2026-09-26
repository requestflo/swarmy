import type { ReleaseView } from '@swarmy/core';
import { versionOf } from './incident-words';

/** A release that went out this long before the incident opened is a suspect. */
export const DEPLOY_SUSPECT_MIN = 30;
/** A server this busy is worth naming. */
export const BUSY_CPU_PCT = 85;
export const BUSY_MEM_PCT = 90;

/** The slowest span in the worst recent error trace (self time: its own wait, not its children's). */
export interface SlowSpan {
  traceId: string;
  part: string;
  name: string;
  ms: number;
}

export interface ServerSignal {
  name: string;
  status: string;
  live: { cpuPercent: number; memPercent: number } | null;
}

export interface GuessInput {
  openedAt: string;
  /** The app's releases, newest first. */
  releases: ReleaseView[];
  slowSpan: SlowSpan | null;
  /** The servers; null while unknown (no line is written). */
  servers: ServerSignal[] | null;
}

export interface Guess {
  cause: 'deploy' | 'server' | 'trace' | 'unknown';
  headline: string;
  lines: string[];
  /** The release that went out just before (cause = deploy). */
  suspect: ReleaseView | null;
  /** The newest earlier release that ran healthy — offered as the put-back. */
  putBack: ReleaseView | null;
  traceId: string | null;
}

/** 240 → "240 ms", 1600 → "1.6 s", 10000 → "10 s". */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 100) / 10;
  return `${Number.isInteger(s) ? s.toFixed(0) : s} s`;
}

function minutesWords(min: number): string {
  if (min < 1) return 'moments';
  if (min === 1) return 'a minute';
  return `${min} minutes`;
}

function serverLine(servers: ServerSignal[] | null): { line: string | null; culprit: string | null } {
  if (!servers || servers.length === 0) return { line: null, culprit: null };
  const offline = servers.find((s) => s.status === 'offline');
  if (offline) return { line: `Server ${offline.name} is offline.`, culprit: offline.name };
  const busy = servers.find((s) => s.live && (s.live.cpuPercent >= BUSY_CPU_PCT || s.live.memPercent >= BUSY_MEM_PCT));
  if (busy?.live) {
    const what = busy.live.cpuPercent >= BUSY_CPU_PCT ? `CPU at ${Math.round(busy.live.cpuPercent)}%` : `memory at ${Math.round(busy.live.memPercent)}%`;
    return { line: `Server ${busy.name} is busy: ${what}.`, culprit: busy.name };
  }
  return { line: 'The servers look normal.', culprit: null };
}

/**
 * swarmy's best guess, from real signals only:
 * 1. a release started within DEPLOY_SUSPECT_MIN before the incident opened → the deploy;
 * 2. an offline or busy server → the server;
 * 3. a slow span in a recent error trace → that call;
 * otherwise "Not sure yet". Every signal found is also written as a line.
 */
export function bestGuess(input: GuessInput): Guess {
  const opened = Date.parse(input.openedAt);
  const idx = input.releases.findIndex((r) => {
    const at = Date.parse(r.createdAt);
    return at <= opened && opened - at <= DEPLOY_SUSPECT_MIN * 60_000;
  });
  const suspect = idx >= 0 ? input.releases[idx]! : null;
  const putBack = suspect ? (input.releases.slice(idx + 1).find((r) => r.status === 'healthy' || r.status === 'superseded') ?? null) : null;
  const span = input.slowSpan;
  const spanLine = span ? `Trace spans show ${span.part} waiting ${durationWords(span.ms)} on ${span.name}.` : null;
  const server = serverLine(input.servers);
  const lines = [spanLine, server.line].filter((l): l is string => l !== null);
  const traceId = span?.traceId ?? null;

  if (suspect) {
    const mins = Math.round((opened - Date.parse(suspect.createdAt)) / 60_000);
    const version = versionOf(suspect.images) ?? 'A new version';
    return {
      cause: 'deploy',
      headline: `Likely the deploy: ${version} went out ${minutesWords(mins)} before this started.`,
      lines, suspect, putBack, traceId,
    };
  }
  if (server.culprit) {
    return { cause: 'server', headline: `Likely the server: ${server.line}`, lines: spanLine ? [spanLine] : [], suspect: null, putBack: null, traceId };
  }
  if (span) {
    return { cause: 'trace', headline: `Likely a slow call: ${span.part} is waiting on ${span.name}.`, lines, suspect: null, putBack: null, traceId };
  }
  return {
    cause: 'unknown',
    headline: 'Not sure yet.',
    lines: [`Nothing went out in the ${DEPLOY_SUSPECT_MIN} minutes before it started.`, ...lines],
    suspect: null, putBack: null, traceId,
  };
}

/** Span rows as the trace detail returns them. */
export interface SpanLike {
  span_id: string;
  parent_span_id: string;
  service_name: string;
  span_name: string;
  duration_ms: number;
}

/** The span with the most self time (its duration minus its children's) — where the request waited. */
export function slowestSpan(traceId: string, spans: SpanLike[]): SlowSpan | null {
  let best: SlowSpan | null = null;
  for (const s of spans) {
    const children = spans.filter((c) => c.parent_span_id === s.span_id).reduce((n, c) => n + c.duration_ms, 0);
    const self = Math.max(0, s.duration_ms - children);
    if (!best || self > best.ms) best = { traceId, part: s.service_name, name: s.span_name, ms: self };
  }
  return best && best.ms > 0 ? best : null;
}
