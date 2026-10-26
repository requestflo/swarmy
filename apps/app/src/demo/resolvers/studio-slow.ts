import type { DomainResolvers } from '../types';

/**
 * `studio.slowQueries` demo resolver: the storefront app's managed Postgres
 * (`db`) with a day of 5-minute pg_stat_statements snapshots summed. Shape
 * mirrors `studio-slow.service.ts`: mean and spread over the window, the
 * slowest call since the reset, no p95.
 */
const NOTE =
  'Postgres keeps each statement’s mean, spread and slowest call, not the time of every call, so there is no honest p95 to show. ± is the spread (standard deviation) over these hours; slowest is the slowest single call since the statistics were last reset.';

const ROWS = [
  { queryId: '-4183920113', query: 'SELECT sum(qty*price) FROM order_items WHERE cart_id = $1', calls: 12_400, totalMs: 5_108_800, meanMs: 412, stddevMs: 236, maxMs: 2_840, rows: 12_400, samples: 288 },
  { queryId: '771203994', query: 'SELECT * FROM products WHERE lower(name) LIKE $1', calls: 3_100, totalMs: 582_800, meanMs: 188, stddevMs: 61, maxMs: 1_120, rows: 9_300, samples: 241 },
  { queryId: '1290341', query: 'UPDATE carts SET updated_at = now() WHERE id = $1', calls: 48_210, totalMs: 192_840, meanMs: 4, stddevMs: 2.6, maxMs: 88, rows: 48_210, samples: 288 },
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
        note: NOTE,
      };
    },
  },
};
