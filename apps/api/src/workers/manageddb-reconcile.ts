import { hub, store } from '../gateway';

/**
 * Managed DB replica reconcile worker (epic #8).
 *
 * Every ~15s, for each org, read the managed-DB clusters off the LIVE inventory
 * (services carrying `swarmy.db.engine` + `swarmy.db.cluster`) and converge each
 * cluster's read-replica service to its declared replica count
 * (`swarmy.db.replicas`). Pure Docker-truth: reads the hub snapshot, dispatches
 * `service.scale` to the org's manager, no DB.
 *
 * The label scheme is mirrored from `@swarmy/trpc` manageddb.service.ts — a
 * worker cannot subpath-import an internal trpc module (same constraint the
 * region/geodns reconcile workers document), so the constants are inlined and
 * kept in sync.
 *
 * Scope (deferred, see plans/managed-db-topology.md): this converges the replica
 * *count* only. Failover/promotion, network ensure, and proxy endpoints are
 * future work — the primary is left untouched (always 1 writer).
 */

const TICK_MS = 15_000;
const DB_ENGINE_LABEL = 'swarmy.db.engine';
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_REPLICAS_LABEL = 'swarmy.db.replicas';

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  for (const s of services) {
    // Only the read-replica member carries a meaningful desired-count target.
    if (s.labels[DB_ENGINE_LABEL] !== 'postgres') continue;
    if (s.labels[DB_ROLE_LABEL] !== 'replica') continue;
    if (!s.labels[DB_CLUSTER_LABEL]) continue;

    const declared = Number.parseInt(s.labels[DB_REPLICAS_LABEL] ?? '', 10);
    if (Number.isNaN(declared) || declared < 0) continue;

    const desired = s.desiredReplicas ?? 0;
    if (declared !== desired) {
      await hub
        .dispatch(node, 'service.scale', { service: s.name, replicas: declared })
        .catch(() => undefined);
    }
  }
}

export function startManagedDbReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
