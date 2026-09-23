import { REGION_OF_LABEL, REGION_PARENT_LABEL, STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
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

/**
 * Placement constraints that pin a service to ONE place (a region, a host, a
 * node id). A sibling in another region must not inherit them — they'd make
 * it unplaceable — so they're dropped before the sibling's own region pin.
 */
const PINNING_CONSTRAINT_RE = /^\s*(node\.labels\.swarmy\.region|node\.hostname|node\.id)\s*(==|!=)/;

/**
 * PURE — cut a per-region sibling spec from the parent's FULL live spec (from
 * `liveServiceSpec`, never the lossy inventory view). Carried verbatim:
 * image, env, command/args, mounts, secrets/configs (with file targets),
 * networks, healthcheck, resources, restart policy, stop grace, and the
 * parent's non-pinning placement (other constraints, spread preferences,
 * max-per-node). Swapped per region: name `<parent>-<region>`, replicas, a
 * `node.labels.swarmy.region==<region>` pin, and a CLEAN label set (markers +
 * inherited stack only — never the parent's region declarations / ingress
 * routes / scale-to-zero labels, which would make the sibling a second
 * declaration holder or double-route it).
 *
 * Published PORTS are dropped: N siblings can't all publish the same ingress
 * port; per-region reach is Geo-DNS + regional ingress.
 *
 * VOLUMES: mounts are kept as-is, including NAMED volumes. Docker volumes are
 * node-local, so a sibling in another region gets its OWN (initially empty)
 * volume of the same name on whichever node it lands — it does NOT share the
 * parent's data. That is the correct shape for caches/scratch and for apps
 * that replicate at the application layer; state that must be shared across
 * regions belongs in a managed data service (replicated DB / object storage),
 * not a named volume. Bind mounts need the host path on the sibling's nodes.
 */
export function siblingSpecFrom(
  live: ServiceSpec,
  parent: { name: string; labels: Record<string, string> },
  region: string,
  replicas: number,
): ServiceSpec {
  const rest: ServiceSpec = { ...live };
  delete rest.ports;
  const stack = parent.labels[STACK_LABEL];
  const inherited = (live.placement?.constraints ?? []).filter((c) => !PINNING_CONSTRAINT_RE.test(c));
  return {
    ...rest,
    name: `${parent.name}-${region}`,
    mode: { replicated: { replicas } },
    labels: {
      'swarmy.managed': 'true',
      [REGION_PARENT_LABEL]: parent.name,
      [REGION_OF_LABEL]: region,
      ...(stack ? { [STACK_LABEL]: stack } : {}),
    },
    placement: {
      ...(live.placement ?? {}),
      constraints: [...inherited, `node.labels.${REGION_NODE_LABEL}==${region}`],
    },
  };
}

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

/** One row of the materialisation plan: a region's declared intent vs live siblings. */
export interface RegionPlanEntry {
  region: string;
  /** Declared replicas for this region (`swarmy.region.<region>.replicas`); 0 ⇒ the
   *  sibling is an orphan pending removal by the reconcile worker. */
  desired: number;
  /** Running replicas of the live `<name>-<region>` sibling (0 if not materialised yet). */
  running: number;
}

/**
 * The live per-region materialisation plan for a logical service: declared
 * intent (parent `swarmy.region.<region>.replicas` labels) reconciled against the
 * running sibling services (`swarmy.region.parent == <name>`) the region-reconcile
 * worker materialises. Pure Docker-truth read from the hub — no DB.
 *
 * Union of declared regions and live-sibling regions, so the view surfaces both
 * regions still converging (declared, sibling not up yet ⇒ running 0) and orphan
 * siblings the worker is about to remove (no longer declared ⇒ desired 0).
 */
export async function getRegionPlan(ctx: OrgContext, serviceId: string): Promise<RegionPlanEntry[]> {
  const parent = liveServiceById(ctx, serviceId);
  if (!parent) throw notFound('service', serviceId);

  const declared = parseRegionReplicas(parent.labels);

  const siblings = new Map<string, SwarmServiceInfo>();
  const { services } = ctx.hub.liveInventory(ctx.activeOrgId);
  for (const s of services) {
    if (s.labels[REGION_PARENT_LABEL] !== parent.name) continue;
    const region = s.labels[REGION_OF_LABEL];
    if (region) siblings.set(region, s);
  }

  const regions = new Set<string>([...declared.keys(), ...siblings.keys()]);
  return [...regions]
    .sort((a, b) => a.localeCompare(b))
    .map((region) => ({
      region,
      desired: declared.get(region) ?? 0,
      running: siblings.get(region)?.runningReplicas ?? 0,
    }));
}
