import { REGION_OF_LABEL, REGION_PARENT_LABEL, STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Per-region replicas reconcile worker (epic #7 — "the gamechanger").
 *
 * Swarm cannot pin *different* replica counts per region on a single service: a
 * service has ONE replica count and ONE placement, so "2 in us-east, 3 in
 * us-west" is unrepresentable on one object. This worker therefore MATERIALISES
 * each declared region as its own label-restricted **sibling Docker service**.
 *
 * Model — parent is the declaration holder, scaled to 0:
 *   A logical app `web` declares its per-region wants via service labels
 *   `swarmy.region.<region>.replicas=<n>`. For each declared region the worker
 *   ensures a sibling service `web-<region>` exists with:
 *     • `replicas = <n>`
 *     • placement constraint `node.labels.swarmy.region==<region>` (pins it)
 *     • labels `swarmy.region.parent=web` + `swarmy.region.of=<region>`
 *       + the parent's `com.docker.stack.namespace` (inherited) + `swarmy.managed`
 *   The parent `web` itself is scaled to 0 — it only carries the declaration and
 *   the spec template (image/env/networks) the siblings are cut from. This is the
 *   cleaner of the two candidate models: every region is symmetric (no "primary"
 *   region living on the parent), so create/scale/remove convergence is uniform.
 *
 * Convergence each tick (idempotent, Docker-truth, no DB):
 *   • create missing siblings   → `service.deploy` (spec cut from the parent)
 *   • scale drifted siblings     → `service.scale`
 *   • remove undeclared siblings → `service.remove`
 *   • park the parent at 0        → `service.scale` (declaration holder)
 *   • strip legacy spread markers → `service.updateLabels` (one-time cleanup)
 *
 * Reused spec fields are image + env + networks (per liveInventory); name,
 * replicas, placement and labels are swapped per region. Published PORTS are
 * deliberately NOT copied: N siblings cannot all publish the same ingress port,
 * and per-region external reach is the job of Geo-DNS (regional ingress), not of
 * each sibling republishing the parent's port. Overlay service-discovery
 * aliasing of the parent name onto the siblings is a follow-up (ServiceSpec has
 * no per-network alias field today).
 *
 * The label scheme is shared with `@swarmy/trpc` region.service.ts; the small
 * parser is inlined because a worker cannot subpath-import an internal trpc
 * module (same constraint as geodns-reconcile). The sibling-marker label
 * constants come from `@swarmy/core` so the inventory + this worker agree.
 */

const TICK_MS = 30_000;
const REGION_REPLICAS_RE = /^swarmy\.region\.(.+)\.replicas$/;
/** Node label naming a node's region (mirror of region.service REGION_NODE_LABEL). */
const REGION_NODE_LABEL = 'swarmy.region';
/** Legacy markers stamped by the previous (total-only) reconcile — cleaned up. */
const LEGACY_SPREAD_LABEL = 'swarmy.region.spread';
const LEGACY_DESIRED_TOTAL_LABEL = 'swarmy.region.desiredTotal';

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

/** Env `KEY=value` strings → a spec env record. */
function envRecord(env: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/**
 * Cut a sibling `ServiceSpec` from the parent: reuse image + env + networks,
 * swap in the region's replica count, a region-pinning placement constraint, the
 * sibling name, and a CLEAN label set (markers + inherited stack only — never the
 * parent's region declarations / ingress / scale-to-zero labels).
 */
function buildSiblingSpec(parent: SwarmServiceInfo, region: string, replicas: number): ServiceSpec {
  const stack = parent.labels[STACK_LABEL];
  return {
    name: `${parent.name}-${region}`,
    image: parent.image,
    mode: { replicated: { replicas } },
    env: envRecord(parent.env ?? []),
    networks: (parent.networks ?? []).map((n) => n.name).filter((n) => n.length > 0),
    labels: {
      'swarmy.managed': 'true',
      [REGION_PARENT_LABEL]: parent.name,
      [REGION_OF_LABEL]: region,
      ...(stack ? { [STACK_LABEL]: stack } : {}),
    },
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  };
}

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);

  // Index live siblings by parent name → region → service.
  const siblingsByParent = new Map<string, Map<string, SwarmServiceInfo>>();
  for (const s of services) {
    const parentName = s.labels[REGION_PARENT_LABEL];
    const region = s.labels[REGION_OF_LABEL];
    if (!parentName || !region) continue;
    const byRegion = siblingsByParent.get(parentName) ?? new Map<string, SwarmServiceInfo>();
    byRegion.set(region, s);
    siblingsByParent.set(parentName, byRegion);
  }

  for (const parent of services) {
    // Siblings are materialised, never declaration holders themselves.
    if (parent.labels[REGION_PARENT_LABEL]) continue;
    // Per-region replicas only make sense for replicated services.
    if (parent.mode !== 'replicated') continue;

    const declared = parseRegionReplicas(parent.labels);
    if (declared.size === 0) continue;

    const existing = siblingsByParent.get(parent.name) ?? new Map<string, SwarmServiceInfo>();

    // (1) Create missing siblings; scale drifted ones.
    for (const [region, replicas] of declared) {
      const sib = existing.get(region);
      if (!sib) {
        const spec = buildSiblingSpec(parent, region, replicas);
        await hub
          .dispatch(node, 'service.deploy', { spec, pullPolicy: 'always' })
          .catch(() => undefined);
      } else if ((sib.desiredReplicas ?? 0) !== replicas) {
        await hub
          .dispatch(node, 'service.scale', { service: sib.name, replicas })
          .catch(() => undefined);
      }
    }

    // (2) Remove siblings for regions no longer declared.
    for (const [region, sib] of existing) {
      if (declared.has(region)) continue;
      await hub.dispatch(node, 'service.remove', { service: sib.name }).catch(() => undefined);
    }

    // (3) Park the parent at 0 — it is the declaration holder, not a workload.
    if ((parent.desiredReplicas ?? 0) !== 0) {
      await hub
        .dispatch(node, 'service.scale', { service: parent.name, replicas: 0 })
        .catch(() => undefined);
    }

    // (4) One-time cleanup of the previous worker's total-only marker labels.
    const removeKeys = [LEGACY_SPREAD_LABEL, LEGACY_DESIRED_TOTAL_LABEL].filter(
      (k) => k in parent.labels,
    );
    if (removeKeys.length > 0) {
      await hub
        .dispatch(node, 'service.updateLabels', { service: parent.name, add: {}, removeKeys })
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
