import {
  DB_DATA_VOLUME_LABEL,
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  DB_FAILOVER_PROMOTING_LABEL,
  DB_PIN_NODE_LABEL,
  DB_SWITCHOVER_LABEL,
  plannedRestartActive,
  type DbPlacementNode,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { geoDeclarations, nodeRegion } from './manageddb-promotion-plan';
import { promotedCopySpec } from './manageddb-reshape';

/**
 * PURE — what a managed Postgres writer is missing that a promotion should
 * have left on it, as one repair (manageddb-writer-guard runs it):
 *
 *   - UNPINNED: a promoted writer (not the canonical `<base>-primary`, whose
 *     pin the storage adoption owns) with no `swarmy.db.node` is redeployed
 *     as its one copy, pinned to the server its only running copy is on,
 *     stop-first. No running copy, or several, or an unknown server ⇒ no
 *     guess. A PITR writer is only labelled (its applied marker dropped): the
 *     PITR convergence redeploys it pinned, with its archive bits.
 *   - GEO DECLARATIONS: on a geo cluster, the writer has no
 *     `swarmy.db.region.<r>.replicas` / `swarmy.db.writeRegion` while another
 *     member (a writer demoted before this fix) still does: they move to the
 *     writer (the write region naming where the writer's data is), and the
 *     writer-only ones leave the other members.
 *
 * Nothing while the writer is mid-flight (being reshaped, a held failover, a
 * planned switchover or restart). Null when there is nothing to repair.
 */

const REGION = 'swarmy.db.region';
const WRITE_REGION = 'swarmy.db.writeRegion';
const PLACED_REGION = 'swarmy.db.placedRegion';
const PITR_APPLIED = 'swarmy.db.pitr.applied';
const REGION_REPLICAS_RE = /^swarmy\.db\.region\.(.+)\.replicas$/;

export interface WriterRepairInput {
  base: string;
  topology: string;
  writer: SwarmServiceInfo;
  /** The cluster's other Postgres members (standbys, a demoted writer). */
  others: readonly SwarmServiceInfo[];
  /** The swarm node of each running copy of the writer (null = not known). */
  copyNodes: readonly (string | null)[];
  nodes: readonly DbPlacementNode[];
  net: string;
  now: number;
}

export interface WriterRepair {
  writer: string;
  /** The writer redeployed pinned (its restored labels included); else a labels-only update. */
  spec: ServiceSpec | null;
  add: Record<string, string>;
  removeKeys: string[];
  /** Writer-only declarations taken off the members that held them. */
  strip: Array<{ service: string; removeKeys: string[] }>;
  pinnedTo: string | null;
  restored: string[];
  /** Deterministic: the guard sends one repair once. */
  signature: string;
}

function settled(labels: Record<string, string>, now: number): boolean {
  const busy = [DB_FAILOVER_PROMOTING_LABEL, DB_FAILOVER_PENDING_LABEL, DB_FAILOVER_CONFIRM_LABEL, DB_SWITCHOVER_LABEL];
  return !busy.some((k) => labels[k] !== undefined) && !plannedRestartActive(labels, now);
}

/** The geo declarations the writer lacks and another member still holds (with the writer's region). */
function restoredGeo(i: WriterRepairInput, pin: string | undefined): Record<string, string> {
  if (i.topology !== 'geo') return {};
  const w = i.writer.labels;
  const held = Object.assign({}, ...i.others.map((m) => geoDeclarations(m.labels))) as Record<string, string>;
  const out: Record<string, string> = {};
  if (!Object.keys(w).some((k) => REGION_REPLICAS_RE.test(k))) {
    for (const [k, v] of Object.entries(held)) if (REGION_REPLICAS_RE.test(k)) out[k] = v;
  }
  if (!w[WRITE_REGION] && held[WRITE_REGION]) {
    const region = w[REGION] ?? nodeRegion(i.nodes, pin);
    out[WRITE_REGION] = region ?? held[WRITE_REGION];
    if (region && !w[PLACED_REGION]) out[PLACED_REGION] = region;
  }
  return out;
}

export function planWriterRepair(i: WriterRepairInput): WriterRepair | null {
  const w = i.writer;
  if (!settled(w.labels, i.now)) return null;
  const running = i.copyNodes.length === 1 ? (i.copyNodes[0] ?? null) : null;
  const pinTo = !w.labels[DB_PIN_NODE_LABEL] && w.name !== `${i.base}-primary` && w.labels[DB_DATA_VOLUME_LABEL] ? running : null;
  const add = restoredGeo(i, w.labels[DB_PIN_NODE_LABEL] ?? pinTo ?? undefined);
  const declares = (l: Record<string, string>) => Object.keys(l).some((k) => REGION_REPLICAS_RE.test(k));
  const holds = i.topology === 'geo' && (declares(add) || declares(w.labels));
  const strip = holds
    ? i.others
        .map((m) => ({ service: m.name, removeKeys: Object.keys(geoDeclarations(m.labels)).filter((k) => k !== WRITE_REGION).sort() }))
        .filter((s) => s.removeKeys.length > 0)
    : [];
  if (!pinTo && Object.keys(add).length === 0 && strip.length === 0) return null;
  const pitr = Boolean(pinTo && w.labels[PITR_APPLIED]);
  const removeKeys = pitr ? [PITR_APPLIED] : [];
  if (pitr) add[DB_PIN_NODE_LABEL] = pinTo!;
  const spec = pinTo && !pitr ? promotedCopySpec({ ...w, labels: { ...w.labels, ...add } }, pinTo, i.net) : null;
  const restored = Object.keys(add).filter((k) => k !== DB_PIN_NODE_LABEL).sort();
  const signature = JSON.stringify({ writer: w.name, pinTo, add: Object.entries(add).sort(), removeKeys, strip });
  return { writer: w.name, spec, add, removeKeys, strip, pinnedTo: pinTo, restored, signature };
}
