import type { DbPitrWindowView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's `dbBackups.pitrWindow`: the window the cluster's agent would read
 * from its WAL repo, over the same DB state as data.ts. The base backups are
 * the cluster's wal-g saves, so the window starts when the oldest of them
 * finished, and the newest archived change is a minute ago.
 */

interface DemoDbState {
  dbClusters: Array<{ stack: string; cluster: string; schedule: { engine: string; pitr: boolean } | null }>;
  dbSnapshots: Array<{ id: string; stack: string; cluster: string; time: string; engine: string | null; sizeBytes: string | null }>;
}

const NONE: DbPitrWindowView = { source: 'none', window: null, backups: [], latestWalAt: null, checkedAt: null };

export const dbPitrWindow: DomainResolvers = {
  handlers: {
    'dbBackups.pitrWindow': (i, s: DemoStore): DbPitrWindowView => {
      const b = i as { stack: string; cluster: string };
      const st = s.extra.data as DemoDbState;
      const c = st.dbClusters.find((x) => x.stack === b.stack && x.cluster === b.cluster);
      if (!c?.schedule?.pitr || c.schedule.engine !== 'wal-g') return NONE;
      const backups = st.dbSnapshots
        .filter((x) => x.stack === b.stack && x.cluster === b.cluster && x.engine === 'wal-g')
        .sort((x, y) => x.time.localeCompare(y.time))
        .map((x) => ({
          name: `base_${x.id.padStart(24, '0').slice(-24).toUpperCase()}`,
          finishTime: x.time,
          ...(x.sizeBytes ? { sizeBytes: x.sizeBytes } : {}),
        }));
      const now = Date.now();
      const latestWalAt = new Date(now - 60_000).toISOString();
      const oldest = backups[0];
      return {
        source: 'agent',
        window: oldest ? { from: oldest.finishTime, to: latestWalAt } : null,
        backups,
        latestWalAt,
        checkedAt: new Date(now).toISOString(),
      };
    },
  },
};
