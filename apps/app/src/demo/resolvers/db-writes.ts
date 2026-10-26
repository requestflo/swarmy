import type { DbWritesView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's `dbBackups.writes`: rows changed since each save of a managed
 * database, over data.ts's saves. The story: each database last restarted
 * 50 hours ago (a platform upgrade), so a save from before that says its
 * count started again; after it, about 380 rows change an hour (checkout
 * busier by day, but the demo keeps it even).
 */

interface DemoDbState {
  dbClusters: Array<{ stack: string; cluster: string }>;
  dbSnapshots: Array<{ id: string; stack: string; cluster: string; time: string; engine: string | null; reason?: string | null }>;
}

const HOUR = 3_600_000;
const RESTARTED_MS = 50 * HOUR;
const ROWS_PER_HOUR = 380;
const PHYSICAL = new Set(['wal-g', 'pgbackrest']);

export const dbWritesDemo: DomainResolvers = {
  handlers: {
    'dbBackups.writes': (i, s: DemoStore): DbWritesView => {
      const b = i as { stack: string; cluster: string };
      const st = s.extra.data as DemoDbState;
      if (!st.dbClusters.some((c) => c.stack === b.stack && c.cluster === b.cluster)) {
        return { read: false, database: null, countingSince: null, saves: [] };
      }
      const now = Date.now();
      const restart = now - RESTARTED_MS;
      const saves = st.dbSnapshots
        .filter((x) => x.stack === b.stack && x.cluster === b.cluster && !PHYSICAL.has(x.engine ?? ''))
        .map((x) => {
          const at = Date.parse(x.time);
          const since = at < restart ? { status: 'reset' as const } : { status: 'counted' as const, rows: Math.round(((now - at) / HOUR) * ROWS_PER_HOUR) };
          return { snapshotId: x.id.slice(0, 8), since };
        });
      return { read: true, database: 'app', countingSince: new Date(restart).toISOString(), saves };
    },
  },
};
