import type { AppMinute } from '@swarmy/core';
import type { OrgContext } from '../context';
import { ringOf, trafficAppResolver } from './traffic.service';

/**
 * One app's requests and 5xx answers per minute, every edge and every host
 * the app routes, from the hub's in-memory 1-minute ring (last 6 h). Feeds
 * the deploy safety gate's error trip (`@swarmy/core` `decideErrorTrip`).
 * App = the stack whose `swarmy.ingress.routes` label owns the host, the
 * same resolver traffic.now uses. Minutes with no cells are left out.
 */
export function appTrafficMinutes(ctx: OrgContext, app: string, from: number, to: number): AppMinute[] {
  const appOf = trafficAppResolver(ctx);
  const owner = new Map<string, boolean>();
  const byMinute = new Map<number, AppMinute>();
  for (const c of ringOf(ctx).cells(ctx.activeOrgId, from, to)) {
    let mine = owner.get(c.host);
    if (mine === undefined) owner.set(c.host, (mine = appOf(c.host) === app));
    if (!mine) continue;
    const m = byMinute.get(c.t) ?? { t: c.t, requests: 0, errors5xx: 0 };
    m.requests += c.requests;
    m.errors5xx += c.errors5xx;
    byMinute.set(c.t, m);
  }
  return [...byMinute.values()].sort((a, b) => a.t - b.t);
}
