import type { DbSwitchoverRunView } from '@swarmy/core';

/**
 * Live switchover runs (the Postgres page's progress card): an in-memory
 * relay, one run per cluster, like the drill relay (`drill-progress.ts`).
 * Run state is never stored: a run's record is its `db.switchover*` audit
 * rows, and a controller restart mid-run leaves the request label for the
 * reconcile to settle (it thaws a writer paused past the label's age).
 * Reads are org-scoped here.
 */

/** A finished run stays visible this long. */
const LINGER_MS = 10 * 60_000;

interface Run {
  view: DbSwitchoverRunView;
  endedAt: number | null;
}

const runs = new Map<string, Run>();
const key = (orgId: string, stack: string, cluster: string): string => `${orgId}\u0000${stack}/${cluster}`;

/** Record a run's newest view (the first call begins it). */
export function putSwitchoverRun(orgId: string, view: DbSwitchoverRunView, now = Date.now()): void {
  runs.set(key(orgId, view.stack, view.cluster), { view, endedAt: view.status === 'running' ? null : now });
}

/** The cluster's run in flight, or its last one for a while after it ended. */
export function switchoverRunFor(orgId: string, stack: string, cluster: string, now = Date.now()): DbSwitchoverRunView | null {
  const k = key(orgId, stack, cluster);
  const r = runs.get(k);
  if (!r) return null;
  if (r.endedAt !== null && now - r.endedAt > LINGER_MS) {
    runs.delete(k);
    return null;
  }
  return r.view;
}

/** Is a switchover of this cluster running in this controller now? */
export function switchoverInFlight(orgId: string, stack: string, cluster: string): boolean {
  return runs.get(key(orgId, stack, cluster))?.view.status === 'running';
}

/** Test seam. */
export function resetSwitchoverRuns(): void {
  runs.clear();
}
