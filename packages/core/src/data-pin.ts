/**
 * Node pinning for managed data services with NODE-LOCAL volumes — the pure,
 * generalised form of the managed-Postgres model in `manageddb-storage.ts`.
 *
 * The bug this prevents: a floating replicated service (cache, search, vector)
 * mounts a named `local` volume. When the node running it reboots, swarm
 * reschedules the task onto ANOTHER node, where Docker silently creates a
 * fresh, EMPTY volume of the same name — the data (and anything restored into
 * it) is left behind on the original node.
 *
 * The model (identical for every kind; Postgres uses `swarmy.db.node`):
 *
 *   data member → pinned to ONE swarm node: label `swarmy.<kind>.node=<swarm
 *                 node id>` + placement `node.id==<id>` + one task per node.
 *                 The label is the declaration; every spec rebuild re-derives
 *                 the constraint from it via {@link applyDataPin}.
 *   replicas    → re-sync from the data member, so they float — anti-affine to
 *                 the pinned node on a multi-node swarm, one task per node.
 *
 * Provision chooses the pin with `choosePinNode` (fewest pinned data members of
 * ANY kind — {@link pinnedDataCounts}). An existing unpinned member is adopted
 * IN PLACE onto the node its running task is on right now (that is where its
 * data is) — {@link planDataPin}. With no running task we never guess.
 */
import { DB_PIN_NODE_LABEL, type StorageSpecLike } from './manageddb-storage';

/** Managed data kinds pinned by this module (Postgres has its own richer layout). */
export type PinnedDataKind = 'cache' | 'search' | 'vector';

/** `swarmy.<kind>.node` — the swarm node id a data member is pinned to. */
export function dataPinLabel(kind: PinnedDataKind | 'db'): string {
  return `swarmy.${kind}.node`;
}
export const CACHE_PIN_NODE_LABEL = dataPinLabel('cache');
export const SEARCH_PIN_NODE_LABEL = dataPinLabel('search');
export const VECTOR_PIN_NODE_LABEL = dataPinLabel('vector');
/** `swarmy.<kind>.avoidNode` — replica anti-affinity (`node.id!=<id>`). */
export const CACHE_AVOID_NODE_LABEL = 'swarmy.cache.avoidNode';

/** Every label that pins a data member to a node (drives pin-spreading). */
export const PINNED_DATA_LABELS: readonly string[] = [
  DB_PIN_NODE_LABEL,
  CACHE_PIN_NODE_LABEL,
  SEARCH_PIN_NODE_LABEL,
  VECTOR_PIN_NODE_LABEL,
];

type Placement = NonNullable<StorageSpecLike['placement']>;

const NODE_ID_CONSTRAINT = /^node\.id\s*[!=]=/;

/**
 * Merge a node pin / anti-affinity / one-per-node cap into `placement`. Pure +
 * idempotent: any previous `node.id==`/`node.id!=` constraint is replaced, all
 * other constraints (region pins) and preferences are kept. A pin already
 * implies "not the avoided node", so `avoid` only applies to unpinned members.
 * Returns undefined when nothing remains.
 */
export function pinPlacement(
  placement: Placement | undefined,
  opts: { pin?: string; avoid?: string; onePerNode?: boolean },
): Placement | undefined {
  const constraints = (placement?.constraints ?? []).filter((c) => !NODE_ID_CONSTRAINT.test(c));
  if (opts.pin) constraints.push(`node.id==${opts.pin}`);
  if (opts.avoid && !opts.pin) constraints.push(`node.id!=${opts.avoid}`);
  const out: Placement = { ...(placement ?? {}) };
  if (constraints.length > 0) out.constraints = constraints;
  else delete out.constraints;
  if (opts.onePerNode) out.maxReplicasPerNode = 1;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Re-derive a data member's placement from its declared pin label. `labels`
 * without the pin ⇒ the spec's node constraints are left as they are (legacy /
 * not-yet-adopted). `avoid` is the replica form (no pin label on replicas).
 */
export function applyDataPin<S extends StorageSpecLike>(
  spec: S,
  opts: { pin?: string; avoid?: string; onePerNode?: boolean },
): S {
  if (!opts.pin && !opts.avoid && !opts.onePerNode) return spec;
  const placement = pinPlacement(spec.placement, opts);
  const out = { ...spec };
  if (placement) out.placement = placement;
  else delete out.placement;
  return out;
}

/** Count pinned data members (every kind, Postgres included) per swarm node. */
export function pinnedDataCounts(
  services: ReadonlyArray<{ labels: Record<string, string> }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of services) {
    for (const key of PINNED_DATA_LABELS) {
      const pin = s.labels[key];
      if (pin) out.set(pin, (out.get(pin) ?? 0) + 1);
    }
  }
  return out;
}

export type DataPinPlan =
  /** Already declared — the spec builders carry `node.id==<pin>`. */
  | { kind: 'pinned'; pin: string }
  /** Unpinned but running on exactly one node: pin it THERE, in place (no data move). */
  | { kind: 'adopt'; pin: string }
  /** Unpinned and we cannot tell where the data is — warn, never guess or redeploy. */
  | { kind: 'unplaced'; reason: 'not-running' | 'ambiguous'; message: string };

export const UNPLACED_NOT_RUNNING_MESSAGE =
  'not pinned to a node and no task is running, so swarmy cannot tell which node holds its data volume. ' +
  'It was left unchanged — bring it back up (it will be pinned where it runs), or restore from a backup.';
export const UNPLACED_AMBIGUOUS_MESSAGE =
  'not pinned to a node and tasks are running on more than one node, so swarmy cannot tell which copy of the data volume is authoritative. ' +
  'It was left unchanged — it will be pinned once a single task is running.';

/**
 * Plan a data member's node pin from live truth. Pure.
 * `runningNodes` = swarm node ids of the member's RUNNING tasks.
 */
export function planDataPin(input: {
  labels: Record<string, string>;
  pinLabel: string;
  runningNodes: readonly (string | undefined)[];
}): DataPinPlan {
  const pin = input.labels[input.pinLabel];
  if (pin) return { kind: 'pinned', pin };
  const nodes = [...new Set(input.runningNodes.filter((n): n is string => Boolean(n)))];
  if (nodes.length === 1) return { kind: 'adopt', pin: nodes[0]! };
  if (nodes.length === 0) {
    return { kind: 'unplaced', reason: 'not-running', message: UNPLACED_NOT_RUNNING_MESSAGE };
  }
  return { kind: 'unplaced', reason: 'ambiguous', message: UNPLACED_AMBIGUOUS_MESSAGE };
}
