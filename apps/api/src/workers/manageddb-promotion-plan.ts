import { DB_PIN_NODE_LABEL, primaryDeclarations, type DbPlacementNode } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { repointSpec } from './manageddb-repoint-spec';
import { floatedExWriter, promotedCopySpec } from './manageddb-reshape';

/**
 * The promotion pass's PURE plan (manageddb-reconcile `promoteChosen`): what
 * the promoted writer and every other member look like afterwards, whichever
 * path promoted it — a failover, a planned switchover, the retire flow (both
 * ride the same pass), a 1-copy standby or one copy of several.
 *
 *   - The writer takes the cluster's declarations off the demoted writer:
 *     memory / extensions / pooler (`primaryDeclarations`) and the geo ones,
 *     exactly as provisioning writes them on a writer: every
 *     `swarmy.db.region.<r>.replicas`, and `swarmy.db.writeRegion` +
 *     `swarmy.db.placedRegion` naming the region its data is in (the label
 *     says where the one writer lives; node-local data can't move).
 *   - The writer is pinned to the server its data is on (`swarmy.db.node` +
 *     `node.id==`). A 1-copy standby is redeployed as that one copy, pinned,
 *     stop-first, env unchanged ({@link PromotionPlan.pin}); one copy of
 *     several is reshaped to it (manageddb-reshape). Until then the promoting
 *     mark stays on it, naming the server, so the reshape step finishes a pin
 *     the pass didn't.
 *   - Every other member is repointed and keeps its region. The demoted
 *     writer gives up the writer-only declarations, follows the new write
 *     region, and (geo) stays placed in its own data's region.
 */

const ROLE = 'swarmy.db.role';
const LEADER = 'swarmy.db.leader';
const REGION = 'swarmy.db.region';
const REPLICAS = 'swarmy.db.replicas';
const WRITE_REGION = 'swarmy.db.writeRegion';
const PLACED_REGION = 'swarmy.db.placedRegion';
const NODE_REGION = 'swarmy.region';
const REGION_REPLICAS_RE = /^swarmy\.db\.region\.(.+)\.replicas$/;

type Labels = Record<string, string> | undefined;

/** The writer-only geo declarations on `labels`: per-region replicas, write + placed region. */
export function geoDeclarations(labels: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (REGION_REPLICAS_RE.test(k) || k === WRITE_REGION || k === PLACED_REGION) out[k] = v;
  }
  return out;
}

/** The `swarmy.region` of a swarm node, when the inventory knows it. */
export function nodeRegion(nodes: readonly DbPlacementNode[], swarmNodeId: string | undefined): string | undefined {
  return swarmNodeId ? nodes.find((n) => n.swarmNodeId === swarmNodeId)?.labels?.[NODE_REGION] || undefined : undefined;
}

/**
 * The geo declarations a writer whose data is in `region` takes over from
 * the demoted writer's labels `old`. No declared write region ⇒ none is
 * invented. An unknown `region` keeps the declared one, unplaced (the
 * reconcile re-places it only when its server is in that region).
 */
export function writerGeoCarry(old: Labels, region: string | undefined): Record<string, string> {
  const out = geoDeclarations(old);
  delete out[WRITE_REGION];
  delete out[PLACED_REGION];
  const declared = old?.[WRITE_REGION];
  if (!declared) return out;
  return { ...out, [WRITE_REGION]: region ?? declared, ...(region ? { [PLACED_REGION]: region } : {}) };
}

/**
 * After a geo failover the writer may be a region's sibling service
 * (`<base>-replica-<region>`): that region's sibling slot is taken, and a
 * replica spec under that name would turn the writer into a standby.
 */
export function regionSlotTaken(base: string, region: string, writer: string): boolean {
  return `${base}-replica-${region}` === writer;
}

export interface PromotionInput {
  /** The demoted writer, while its service is there. */
  primary?: SwarmServiceInfo;
  /** The promoted service, and the swarm node of the ONE copy promoted. */
  target: SwarmServiceInfo;
  node: string;
  /** The cluster's standby members (the target among them is skipped). */
  standbys: readonly SwarmServiceInfo[];
  topology: string;
  /** The target holds other copies too: it is reshaped to the promoted one. */
  reshape: boolean;
  net: string;
  /** The promotion's rejoin epoch (`SWARMY_PG_REJOIN`). */
  epoch: string;
  nodes: readonly DbPlacementNode[];
}

export interface PromotionPlan {
  /** Labels-only flip on the promoted service, before anything else moves. */
  writer: Record<string, string>;
  /** The 1-copy writer as that copy, pinned to its server; null when reshaped (the reshape pins it). */
  pin: ServiceSpec | null;
  /** Every other member, repointed at the writer. */
  repoint: ServiceSpec[];
  /** The write region, when the cluster declares one and the writes moved region. */
  writeRegion?: { from: string; to: string };
}

export function planPromotion(i: PromotionInput): PromotionPlan {
  const old = i.primary?.labels;
  const region = i.target.labels[REGION] ?? nodeRegion(i.nodes, i.node);
  const writer: Record<string, string> = { [ROLE]: 'primary', [LEADER]: i.target.name, ...primaryDeclarations(old), ...writerGeoCarry(old, region) };
  const pin = i.reshape ? null : promotedCopySpec({ ...i.target, labels: { ...i.target.labels, ...writer } }, i.node, i.net);
  const to = writer[WRITE_REGION];
  // When the promoted service held the base standby copies, the demoted writer
  // takes them over: floating, off the new writer's server, as many as before.
  const floatEx = i.reshape && i.topology !== 'geo' && !i.target.labels[REGION];
  const copies = Number.parseInt(i.target.labels[REPLICAS] ?? '', 10) || (i.target.desiredReplicas ?? 1);
  const repoint: ServiceSpec[] = [];
  for (const m of [i.primary, ...i.standbys]) {
    if (!m || m.name === i.target.name || m.labels[ROLE] === 'dcs') continue;
    const labels: Record<string, string> = { ...m.labels, ...(to ? { [WRITE_REGION]: to } : {}) };
    let place = labels[REGION];
    if (m === i.primary) {
      for (const k of Object.keys(geoDeclarations(labels))) if (k !== WRITE_REGION) delete labels[k];
      if (i.topology === 'geo') place ??= old?.[PLACED_REGION] ?? nodeRegion(i.nodes, old?.[DB_PIN_NODE_LABEL]);
    }
    const s = floatEx && m === i.primary ? floatedExWriter({ ...m, labels }, i.node, copies) : { ...m, labels };
    repoint.push(repointSpec(s, i.target.name, i.net, i.epoch, i.nodes, place));
  }
  const from = old?.[WRITE_REGION];
  return { writer, pin, repoint, ...(from && to && from !== to ? { writeRegion: { from, to } } : {}) };
}
