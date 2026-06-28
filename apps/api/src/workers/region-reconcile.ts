import { hub, store } from '../gateway';

/**
 * Per-region replicas reconcile worker (epic #7 — "the gamechanger").
 *
 * For every live service that declares per-region replicas via Docker labels
 * (`swarmy.region.<region>.replicas=<n>`) this:
 *   1. sets the service's total desired replicas = the sum of per-region counts
 *      (`service.scale`), and
 *   2. stamps a spread marker (`swarmy.region.spread = node.labels.swarmy.region`)
 *      plus the computed total (`swarmy.region.desiredTotal`) via
 *      `service.updateLabels`, so replicas distribute across regions and Geo-DNS
 *      steering can read per-region capacity.
 *
 * Pure Docker-truth: reads the live inventory from the hub, dispatches to the
 * org's manager, no DB. The label scheme is mirrored from
 * `@swarmy/trpc` region.service.ts — a worker cannot subpath-import an internal
 * trpc module (same constraint as geodns-reconcile), so the small parser is
 * inlined and kept in sync.
 *
 * Caveat: Swarm cannot natively pin "2 in us-east, 3 in us-west" on one
 * service. With only `service.scale` + `service.updateLabels` we converge the
 * *total* replica count and a region-spread placement hint; exact per-region
 * pinning would need one service per region (a future split) or a placement
 * preference baked into the deploy spec. Documented here intentionally.
 */

const TICK_MS = 30_000;
const REGION_REPLICAS_RE = /^swarmy\.region\.(.+)\.replicas$/;
const SPREAD_LABEL = 'swarmy.region.spread';
const SPREAD_VALUE = 'node.labels.swarmy.region';
const DESIRED_TOTAL_LABEL = 'swarmy.region.desiredTotal';

function parseRegionReplicas(labels: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(labels)) {
    const match = REGION_REPLICAS_RE.exec(key);
    if (!match) continue;
    const region = match[1];
    const n = Number.parseInt(value, 10);
    if (!region || Number.isNaN(n) || n < 0) continue;
    out.set(region, n);
  }
  return out;
}

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  for (const s of services) {
    const declared = parseRegionReplicas(s.labels);
    if (declared.size === 0) continue;

    let total = 0;
    for (const n of declared.values()) total += n;
    const desired = s.desiredReplicas ?? 0;

    // (1) Converge total replica count to the sum of per-region declarations.
    if (total !== desired) {
      await hub
        .dispatch(node, 'service.scale', { service: s.name, replicas: total })
        .catch(() => undefined);
    }

    // (2) Stamp spread + total marker labels, only when they drift (no churn).
    const add: Record<string, string> = {};
    if (s.labels[SPREAD_LABEL] !== SPREAD_VALUE) add[SPREAD_LABEL] = SPREAD_VALUE;
    if (s.labels[DESIRED_TOTAL_LABEL] !== String(total)) add[DESIRED_TOTAL_LABEL] = String(total);
    if (Object.keys(add).length > 0) {
      await hub
        .dispatch(node, 'service.updateLabels', { service: s.name, add, removeKeys: [] })
        .catch(() => undefined);
    }
  }
}

export function startRegionReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
