import { regionCoord, steer, type SteerTarget } from '@swarmy/dns/steer';
import type { DomainResolvers } from '../types';
import { deriveRows, getState } from './geo';

/**
 * `geodns.simulateDown` (board 32) in demo mode: the same steering the
 * engine runs (closest healthy first, two answers, everyone when none is
 * healthy) from each visitor region, with one front door marked down. Like
 * the real query it changes nothing.
 */
export const geoSimulate: DomainResolvers = {
  handlers: {
    'geodns.simulateDown': (i, s) => {
      const b = i as { id: string; host: string; ip: string; regions: string[] };
      const z = getState(s).zones.find((x) => x.id === b.id);
      if (!z) throw new Error(`zone not found: ${b.id}`);
      const host = b.host.toLowerCase().replace(/\.+$/, '');
      const row = deriveRows(s).find((r) => r.zone === z.zone && r.host === host);
      const edge = row?.endpoints.find((e) => e.ip === b.ip);
      if (!row || !edge) throw new Error(`${b.ip} is not a front door that answers for ${z.zone}`);
      const now: SteerTarget[] = row.endpoints.map((e) => ({ target: e.ip, region: e.region, healthy: e.healthy }));
      const then = now.map((t) => (t.target === b.ip ? { ...t, healthy: false } : t));
      const regions = b.regions.map((from) => {
        const client = { coord: regionCoord(from), region: from };
        const before = steer({ client, targets: now, maxAnswers: 2 });
        const after = steer({ client, targets: then, maxAnswers: 2 });
        return {
          from,
          before: before.answers.map((t) => t.target),
          after: after.answers.map((t) => t.target),
          degraded: after.degraded,
          steered: !after.unlocated,
        };
      });
      return { host, ttl: z.ttl, down: { ip: edge.ip, region: edge.region, healthy: edge.healthy }, regions };
    },
  },
};
