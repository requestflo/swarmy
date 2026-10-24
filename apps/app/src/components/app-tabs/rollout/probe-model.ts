import type { HealthCopyView, HealthTestView } from '@swarmy/core';

/**
 * "Last N probes" (board AppRollout) said over what Docker really kept — it
 * holds 5 per copy, so N is the true count, never a promise of 60.
 * PURE — unit-tested in probe-model.test.ts.
 */

export interface ProbeSummary {
  count: number;
  copies: number;
  p50Ms: number;
  slow: { ms: number; at: number }[];
  misses: number;
}

/** "4.2 ms" · "212 ms" · "1.4 s". */
export function sayMs(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 100) / 10} s`;
  return `${ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)} ms`;
}

export function summarizeProbes(copies: HealthCopyView[]): ProbeSummary | null {
  const all = copies.flatMap((c) => c.probes);
  if (all.length === 0) return null;
  const sorted = all.map((p) => p.durationMs).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const p50Ms = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  // Slow = well past the typical probe: 4× the median and at least 50 ms.
  const bar = Math.max(p50Ms * 4, 50);
  const slow = all
    .filter((p) => p.exitCode === 0 && p.durationMs >= bar)
    .map((p) => ({ ms: p.durationMs, at: p.at }))
    .sort((a, b) => a.at - b.at);
  return { count: all.length, copies: copies.filter((c) => c.probes.length > 0).length, p50Ms, slow, misses: all.filter((p) => p.exitCode !== 0).length };
}

const hhmm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "p50 4 ms · one slow 212 ms at 10:31 · 0 misses". */
export function probeLine(s: ProbeSummary, time: (at: number) => string = hhmm): string {
  const parts = [`p50 ${sayMs(s.p50Ms)}`];
  const [first] = s.slow;
  if (s.slow.length === 1 && first) parts.push(`one slow ${sayMs(first.ms)} at ${time(first.at)}`);
  else if (s.slow.length > 1) parts.push(`${s.slow.length} slow, up to ${sayMs(Math.max(...s.slow.map((x) => x.ms)))}`);
  parts.push(`${s.misses} miss${s.misses === 1 ? '' : 'es'}`);
  return parts.join(' · ');
}

/** "Passed in 4.2 ms on wkr-1" · "Failed with exit code 7 after 12 ms on wkr-1" · "No answer within 30 s on wkr-1". */
export function testLine(r: HealthTestView): string {
  const on = r.node ? ` on ${r.node}` : '';
  if (r.timedOut) return `No answer within ${sayMs(r.durationMs)}${on}. Docker would count that as a miss.`;
  if (r.ok) return `Passed in ${sayMs(r.durationMs)}${on}.`;
  return `Failed with exit code ${r.exitCode} after ${sayMs(r.durationMs)}${on}.`;
}
