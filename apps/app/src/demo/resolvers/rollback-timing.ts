import { rollbackTookSec, type LastRollbackInput, type ReleaseView, type RollbackTimingView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * `releases.lastRollback` in the demo, over the releases store
 * (`releases.ts`): a rollback is a release whose notes say so. Yesterday's
 * automatic put-back of storefront 1.8.2 (rel-store-5) took 41 s; one made in
 * the demo settles when the demo marks it healthy, 8 s after it starts.
 */
const SEEDED_SEC: Record<string, number> = { 'rel-store-5': 41 };
const DEMO_SETTLE_SEC = 8;
const ROLLBACK_NOTE = /^(?:Automatic rollback|Rollback) to release (\S+)/;

function timingOf(r: ReleaseView): RollbackTimingView | null {
  const of = ROLLBACK_NOTE.exec(r.notes ?? '')?.[1];
  if (!of) return null;
  const sec = SEEDED_SEC[r.id] ?? (r.status === 'healthy' ? DEMO_SETTLE_SEC : null);
  if (sec === null) return null;
  const start = new Date(r.createdAt);
  const healthy = new Date(start.getTime() + sec * 1000);
  return { releaseId: r.id, stackName: r.stackName, rollbackOf: of, startedAt: start.toISOString(), healthyAt: healthy.toISOString(), tookSec: rollbackTookSec(start, healthy) };
}

export const rollbackTiming: DomainResolvers = {
  handlers: {
    'releases.lastRollback': (i, s: DemoStore): RollbackTimingView | null => {
      const { stackName } = (i ?? {}) as LastRollbackInput;
      const rows = (s.extra.releases as { releases: ReleaseView[] } | undefined)?.releases ?? [];
      const measured = rows
        .filter((r) => !stackName || r.stackName === stackName)
        .map(timingOf)
        .filter((t): t is RollbackTimingView => t !== null)
        .sort((a, b) => b.healthyAt.localeCompare(a.healthyAt));
      return measured[0] ?? null;
    },
  },
};
