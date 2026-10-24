import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { slowQueryTargets, snapshotSlowQueries, systemContext } from '@swarmy/trpc';
import { SLOW_SNAPSHOT_MS, type StatementTotals } from '@swarmy/core/studio';
import { hub, store } from '../gateway';

/**
 * Slow queries over 24 h — the snapshot scheduler. Every ~5 minutes, per org
 * with a connected node, for each managed Postgres whose primary has
 * pg_stat_statements applied (`swarmy.db.extensions.applied`, a label read:
 * a cluster without it costs nothing), take one snapshot through the studio's
 * bounded, audited system read and store the deltas (`snapshotSlowQueries` in
 * @swarmy/trpc; the maths is pure in @swarmy/core/studio). This file only
 * ticks and holds each database's previous totals in memory: after a
 * controller restart the first snapshot is a baseline, so one 5-minute window
 * goes unrecorded rather than double-counted. Retention is the hourly
 * retention worker's (`prunePgQuerySamples`).
 */
const FIRST_RUN_DELAY_MS = 60_000;

export function startPgSlowQueries(): () => void {
  const totals = new Map<string, Map<string, StatementTotals>>();
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const seen = new Set<string>();
      for (const orgId of new Set(store.nodeOrg.values())) {
        try {
          const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
          for (const t of slowQueryTargets(ctx)) {
            const key = `${orgId}/${t.stack}/${t.target}`;
            seen.add(key);
            const next = await snapshotSlowQueries(ctx, t, totals.get(key) ?? null).catch(() => null);
            // A failed read keeps the old totals: the next delta spans both windows, still correct.
            if (next) totals.set(key, next.totals);
          }
        } catch {
          // one org's failure never stops the tick
        }
      }
      for (const key of totals.keys()) if (!seen.has(key)) totals.delete(key);
    } finally {
      running = false;
    }
  };

  // Nodes reconnect a few seconds after boot; the first snapshot waits for them.
  const kickoff = setTimeout(() => void run(), FIRST_RUN_DELAY_MS);
  const timer = setInterval(() => void run(), SLOW_SNAPSHOT_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
