import type { DbWalCheckView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's `dbBackups.walCheck`: what `wal-g wal-verify` would say about
 * the wal-g cluster's archive, over the same DB state as data.ts. The demo
 * archive is whole: continuous since the oldest base copy, the newest
 * segment a minute ago still uploading.
 */

interface DemoDbState {
  dbClusters: Array<{ stack: string; cluster: string; schedule: { engine: string; pitr: boolean } | null }>;
  dbSnapshots: Array<{ stack: string; cluster: string; time: string; engine: string | null }>;
}

const NONE: DbWalCheckView = {
  source: 'none',
  status: null,
  continuousSince: null,
  latestWalAt: null,
  gaps: [],
  pendingSegments: 0,
  timeline: null,
  checkedAt: null,
};

export const dbWalCheck: DomainResolvers = {
  handlers: {
    'dbBackups.walCheck': (i, s: DemoStore): DbWalCheckView => {
      const b = i as { stack: string; cluster: string };
      const st = s.extra.data as DemoDbState;
      const c = st.dbClusters.find((x) => x.stack === b.stack && x.cluster === b.cluster);
      if (!c?.schedule?.pitr || c.schedule.engine !== 'wal-g') return NONE;
      const oldest = st.dbSnapshots
        .filter((x) => x.stack === b.stack && x.cluster === b.cluster && x.engine === 'wal-g')
        .map((x) => x.time)
        .sort()[0];
      const now = Date.now();
      return {
        source: 'agent',
        status: 'continuous',
        continuousSince: oldest ?? new Date(now - 86_400_000).toISOString(),
        latestWalAt: new Date(now - 60_000).toISOString(),
        gaps: [],
        pendingSegments: 1,
        timeline: 'ok',
        checkedAt: new Date(now).toISOString(),
      };
    },
  },
};
