import type { DomainResolvers } from '../types';

/**
 * `studio.slowQueries` demo resolver: the storefront app's managed Postgres
 * (`db`) with a day of 5-minute pg_stat_statements snapshots summed. Shape
 * mirrors `studio-slow.service.ts`.
 */
const P95_NOTE =
  'p95 is estimated from each 5-minute average, weighted by calls: Postgres keeps no per-call times, so a single slow call in a busy window is averaged away.';

const ROWS = [
  { queryId: '-4183920113', query: 'SELECT sum(qty*price) FROM order_items WHERE cart_id = $1', calls: 12_400, totalMs: 5_108_800, meanMs: 412, p95Ms: 940, rows: 12_400, samples: 288 },
  { queryId: '771203994', query: 'SELECT * FROM products WHERE lower(name) LIKE $1', calls: 3_100, totalMs: 582_800, meanMs: 188, p95Ms: 310, rows: 9_300, samples: 241 },
  { queryId: '1290341', query: 'UPDATE carts SET updated_at = now() WHERE id = $1', calls: 48_210, totalMs: 192_840, meanMs: 4, p95Ms: 9.5, rows: 48_210, samples: 288 },
];

export const studioSlow: DomainResolvers = {
  handlers: {
    'studio.slowQueries': (i) => {
      const { target, hours } = i as { target: string; hours?: number };
      const windowHours = hours ?? 24;
      return {
        windowHours,
        everyMinutes: 5,
        since: target === 'db' ? new Date(Date.now() - windowHours * 3_600_000).toISOString() : null,
        rows: target === 'db' ? ROWS : [],
        p95Note: P95_NOTE,
      };
    },
  },
};
