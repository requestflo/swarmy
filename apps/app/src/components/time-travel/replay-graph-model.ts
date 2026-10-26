import type { ServiceMapEdgeView } from '@swarmy/core';

/**
 * The replay as a graph, pure: which of the app's parts called which, from
 * the traces of the minutes before T (`observability.map` with `until`), and
 * the parts laid out in columns by call depth: the ones nothing calls first,
 * then what they call, and so on. Only calls the traces saw are drawn: the
 * app's wiring (DATABASE_URL and friends) is not recorded over time, so a
 * past moment never shows today's connections.
 */

export interface ReplayCall {
  from: string;
  to: string;
  callsPerMin: number;
  errorRate: number;
}

/** A trace's service name → the part it is: the part's own name, or `<stack>_<part>`. */
function partOf(stack: string, parts: ReadonlySet<string>, service: string): string | null {
  if (parts.has(service)) return service;
  const short = service.startsWith(`${stack}_`) ? service.slice(stack.length + 1) : null;
  return short && parts.has(short) ? short : null;
}

/** The calls between two of the replay's parts (calls to anything else are not drawn). */
export function replayCalls(stack: string, partNames: readonly string[], edges: readonly ServiceMapEdgeView[]): ReplayCall[] {
  const parts = new Set(partNames);
  const out = new Map<string, ReplayCall>();
  for (const e of edges) {
    const from = partOf(stack, parts, e.from);
    const to = partOf(stack, parts, e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, callsPerMin: prev.callsPerMin + e.callsPerMin } : { from, to, callsPerMin: e.callsPerMin, errorRate: e.errorRate });
  }
  return [...out.values()];
}

/**
 * Columns by call depth (the longest chain of calls into a part), parts in
 * no call last in the first column. A loop can't push a part past the
 * number of parts.
 */
export function replayColumns(partNames: readonly string[], calls: readonly ReplayCall[]): string[][] {
  const depth = new Map(partNames.map((p) => [p, 0]));
  for (let round = 0; round < partNames.length; round++) {
    let moved = false;
    for (const c of calls) {
      const d = (depth.get(c.from) ?? 0) + 1;
      if (d > (depth.get(c.to) ?? 0) && d < partNames.length) {
        depth.set(c.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const linked = new Set(calls.flatMap((c) => [c.from, c.to]));
  const cols: string[][] = [];
  for (const p of partNames) (cols[depth.get(p)!] ??= []).push(p);
  return cols.filter(Boolean).map((col, i) => (i === 0 ? [...col.filter((p) => linked.has(p)), ...col.filter((p) => !linked.has(p))] : col));
}

/** "74/min" · "0.4/min". */
export function rateWords(perMin: number): string {
  return `${perMin >= 10 ? Math.round(perMin) : Math.round(perMin * 10) / 10}/min`;
}
