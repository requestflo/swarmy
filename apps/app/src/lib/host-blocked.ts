import { EDGE_OVERFLOW_HOST, type TrafficNowView } from '@swarmy/core';
import { hostRows } from './host-visits';

/** An address's blocked answers a minute at the edge right now (`traffic.now.hosts`). */
export interface HostBlocked {
  /** 403 + 429 a minute. */
  perMin: number;
  forbiddenPerMin: number;
  tooManyPerMin: number;
  windowMinutes: number;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Blocked = 403 + 429 answers at this address, as the edge counted them —
 * or null when there's no honest number: nothing reported, not through the
 * Caddy edge, no edge reporting status codes (an older agent), or the
 * address may be folded into `_other`. Zero only when the edges report codes
 * and counted none here. A `*.zone` address adds up the hosts it covers.
 */
export function hostBlocked(traffic: TrafficNowView | undefined, host: string, viaEdge = true): HostBlocked | null {
  if (!traffic || traffic.totals.state !== 'reporting' || !viaEdge) return null;
  const rows = hostRows(traffic, host);
  const windowMinutes = traffic.windowMinutes;
  if (rows.length === 0) {
    const reported = typeof traffic.totals.blockedPerMin === 'number';
    if (!reported || traffic.hosts.some((r) => r.host === EDGE_OVERFLOW_HOST)) return null;
    return { perMin: 0, forbiddenPerMin: 0, tooManyPerMin: 0, windowMinutes };
  }
  const known = rows.filter((r) => typeof r.blockedPerMin === 'number');
  if (known.length === 0) return null;
  return {
    perMin: r1(known.reduce((n, r) => n + r.blockedPerMin!, 0)),
    forbiddenPerMin: r1(known.reduce((n, r) => n + (r.forbiddenPerMin ?? 0), 0)),
    tooManyPerMin: r1(known.reduce((n, r) => n + (r.tooManyPerMin ?? 0), 0)),
    windowMinutes,
  };
}
