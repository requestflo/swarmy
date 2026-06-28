import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';

/**
 * Per-region replicas (epic #7 — "the gamechanger").
 *
 * A service declares *how many replicas it wants in each region* and swarmy
 * reconciles that to a live replica count + region-aware placement. Everything
 * is Docker-truth: the declaration lives in **service labels**, regions are read
 * from **node labels**, and there is no new DB.
 *
 *   swarmy.region.<region>.replicas = <n>
 *
 * A "region" is the value of a node's `swarmy.region` label — the same label
 * Geo-DNS steers on (see geodns.service.ts), so per-region capacity declared
 * here feeds Geo-DNS answer-set steering conceptually: more replicas in a region
 * ⇒ that region can carry more steered traffic.
 */

/** Node label naming a node's region/zone (shared with Geo-DNS steering). */
export const REGION_NODE_LABEL = 'swarmy.region';
/** Service-label prefix carrying a declared replica count for one region. */
export const REGION_REPLICAS_PREFIX = 'swarmy.region.';
export const REGION_REPLICAS_SUFFIX = '.replicas';
/** Marker stamped by the reconcile worker with the summed desired total. */
export const REGION_DESIRED_TOTAL_LABEL = 'swarmy.region.desiredTotal';
/** Marker requesting an even spread of replicas across node region labels. */
export const REGION_SPREAD_LABEL = 'swarmy.region.spread';
export const REGION_SPREAD_VALUE = `node.labels.${REGION_NODE_LABEL}`;

const REGION_REPLICAS_RE = /^swarmy\.region\.(.+)\.replicas$/;

/** Build the service-label key that declares replicas for one region. */
export function regionReplicasKey(region: string): string {
  return `${REGION_REPLICAS_PREFIX}${region}${REGION_REPLICAS_SUFFIX}`;
}

/** Extract `{ region → replicas }` from a live service's Docker labels. */
export function parseRegionReplicas(labels: Record<string, string>): Map<string, number> {
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

export interface RegionReplica {
  region: string;
  replicas: number;
}

export interface RegionReplicasView {
  serviceId: string;
  serviceName: string;
  /** Declared per-region replica counts (read from the live service labels). */
  regions: RegionReplica[];
  /** Distinct region labels discovered across the org's nodes + declarations. */
  knownRegions: string[];
  /** Sum of declared per-region replicas = the reconciled desired total. */
  desiredTotal: number;
  /** Replica count Docker currently reports desired for the service. */
  liveDesired: number;
}

/** Resolve a live service (Docker-truth) from the in-memory hub by id or name. */
function liveServiceById(ctx: OrgContext, idOrName: string): SwarmServiceInfo | undefined {
  const { services } = ctx.hub.liveInventory(ctx.activeOrgId);
  return services.find((s) => s.id === idOrName || s.name === idOrName);
}

/**
 * Known regions for the org = distinct `swarmy.region` node labels, unioned with
 * any regions already declared on live services (so a configured region survives
 * a node temporarily dropping its label).
 *
 * Node labels are Docker truth, read from the live swarm node inventory (the hub),
 * the same source Geo-DNS uses. No DB model is introduced or read here.
 */
export async function listKnownRegions(ctx: OrgContext): Promise<string[]> {
  const regions = new Set<string>();

  for (const node of ctx.hub.nodeInventory(ctx.activeOrgId)) {
    const region = node.labels[REGION_NODE_LABEL];
    if (region) regions.add(region);
  }

  const { services } = ctx.hub.liveInventory(ctx.activeOrgId);
  for (const s of services) {
    for (const region of parseRegionReplicas(s.labels).keys()) regions.add(region);
  }

  return [...regions].sort((a, b) => a.localeCompare(b));
}

/** Read the declared per-region replica plan for a service (+ known regions). */
export async function getRegionReplicas(ctx: OrgContext, id: string): Promise<RegionReplicasView> {
  const svc = liveServiceById(ctx, id);
  if (!svc) throw notFound('service', id);

  const declared = parseRegionReplicas(svc.labels);
  const regions: RegionReplica[] = [...declared.entries()]
    .map(([region, replicas]) => ({ region, replicas }))
    .sort((a, b) => a.region.localeCompare(b.region));
  const desiredTotal = regions.reduce((sum, r) => sum + r.replicas, 0);

  return {
    serviceId: svc.id,
    serviceName: svc.name,
    regions,
    knownRegions: await listKnownRegions(ctx),
    desiredTotal,
    liveDesired: svc.desiredReplicas ?? 0,
  };
}

/**
 * Declare N replicas for one region. Persisted Docker-direct as a service label
 * via `service.updateLabels`; `replicas <= 0` removes the declaration. The
 * region-reconcile worker then converges the live replica count + placement.
 */
export async function setRegionReplicas(
  ctx: OrgContext,
  input: { id: string; region: string; replicas: number },
): Promise<{ id: string; ok: true }> {
  const svc = liveServiceById(ctx, input.id);
  if (!svc) throw notFound('service', input.id);

  const node = await resolveManagerNode(ctx);
  const key = regionReplicasKey(input.region);
  const payload =
    input.replicas <= 0
      ? { service: svc.name, add: {}, removeKeys: [key] }
      : { service: svc.name, add: { [key]: String(input.replicas) }, removeKeys: [] };

  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', payload);
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { id: svc.id, ok: true };
}
