/**
 * Managed Postgres STORAGE layout — the one pure source of truth shared by the
 * controller (`@swarmy/trpc` manageddb.service / dbBackup.service) and the
 * manageddb-reconcile worker (which cannot subpath-import trpc internals).
 *
 * Why this exists: clusters used to be deployed with NO mounts, so the image's
 * data VOLUME landed in an anonymous volume and any task restart / reschedule /
 * drain / image update started an EMPTY database. The layout is now:
 *
 *   primary  → named local volume `<stack>_<cluster>-primary-data` mounted at
 *              `/var/lib/postgresql/data` (the official image's VOLUME; PGDATA
 *              is its `pgdata/` subdirectory), pinned to ONE swarm node
 *              (`node.id==<swarm node id>`) so the node-local volume and the
 *              writer never part.
 *   replicas → per-node volume `<stack>_<cluster>-replica-data` (Docker creates
 *              one per node; a replica re-syncs from the primary), at most one
 *              task per node (`maxReplicasPerNode: 1` — two Postgres processes on
 *              one PGDATA would corrupt it), and anti-affinity
 *              `node.id!=<primary node>` when the swarm has more than one node.
 *
 * Docker is the source of truth: each member's layout is DECLARED on its own
 * service labels (`swarmy.db.dataVolume`, `swarmy.db.node`,
 * `swarmy.db.avoidNode`), so every spec rebuild — failover repoint, geo
 * re-placement, PITR apply/strip — re-derives the mounts + constraints from the
 * live labels via {@link applyPgMember} (storage + the swarmy boot layer of
 * `manageddb-pg`) instead of rebuilding a bare spec.
 */
import { defaultDiskMount } from './disk-inventory';
import {
  MANAGED_PG_PGDATA,
  MANAGED_PG_ROOT,
  applyPgBoot,
  applyPgCredential,
  type PgBootSpecLike,
  type PgCredentialSpecLike,
} from './manageddb-pg';

/** Named volume this member's data root (`/var/lib/postgresql/data`) lives on. */
export const DB_DATA_VOLUME_LABEL = 'swarmy.db.dataVolume';
/** Docker swarm node id this member is pinned to (`node.id==<id>`). */
export const DB_PIN_NODE_LABEL = 'swarmy.db.node';
/** Docker swarm node id this member must avoid (`node.id!=<id>`, replica anti-affinity). */
export const DB_AVOID_NODE_LABEL = 'swarmy.db.avoidNode';

/** `<stack>_<cluster>-primary-data` — the primary's persistent PGDATA volume. */
export function primaryDataVolumeName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-primary-data`;
}
/** `<stack>_<cluster>-replica-data` — per-node replica volume (Docker makes one per node). */
export function replicaDataVolumeName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-replica-data`;
}
/** `<base>-replica-<region>-data` — geo region-replica sibling volume. */
export function regionReplicaDataVolumeName(base: string, region: string): string {
  return `${base}-replica-${region}-data`;
}
/** `<base>-primary-<n>-data` — active-active extra primary volume. */
export function extraPrimaryDataVolumeName(base: string, index: number): string {
  return `${base}-primary-${index}-data`;
}

type Mount = {
  type: 'volume' | 'bind' | 'tmpfs';
  source?: string;
  target: string;
  readOnly?: boolean;
};
type Placement = {
  constraints?: string[];
  preferences?: string[];
  maxReplicasPerNode?: number;
};
/** The structural subset of `ServiceSpec` this module touches (keeps core root protocol-free). */
export interface StorageSpecLike {
  mounts?: Mount[];
  placement?: Placement;
}

/** Labels declaring a member's storage layout. Empty entries are omitted. */
export function dbStorageLabels(opts: {
  dataVolume: string;
  pinNode?: string;
  avoidNode?: string;
}): Record<string, string> {
  return {
    [DB_DATA_VOLUME_LABEL]: opts.dataVolume,
    ...(opts.pinNode ? { [DB_PIN_NODE_LABEL]: opts.pinNode } : {}),
    ...(opts.avoidNode ? { [DB_AVOID_NODE_LABEL]: opts.avoidNode } : {}),
  };
}

/**
 * Re-derive a DB member's data mount + placement from its declared labels and
 * merge them onto `spec`. Idempotent; other mounts (wal-archive) and other
 * constraints (region pins) are preserved. The declared data volume WINS the
 * data-root target over any other mount for that path. No storage
 * label ⇒ the spec is returned unchanged (legacy — see {@link dbStorageState}).
 */
export function applyDbStorage<S extends StorageSpecLike>(
  spec: S,
  labels: Record<string, string> | undefined,
): S {
  const dataVolume = labels?.[DB_DATA_VOLUME_LABEL];
  const pin = labels?.[DB_PIN_NODE_LABEL];
  const avoid = labels?.[DB_AVOID_NODE_LABEL];
  if (!dataVolume && !pin && !avoid) return spec;

  const mounts = [...(spec.mounts ?? [])];
  let outMounts = mounts;
  if (dataVolume) {
    outMounts = [
      { type: 'volume', source: dataVolume, target: MANAGED_PG_ROOT },
      ...mounts.filter((m) => m.target !== MANAGED_PG_ROOT),
    ];
  }

  const constraints = [...(spec.placement?.constraints ?? [])].filter(
    (c) => !/^node\.id\s*[!=]=/.test(c),
  );
  if (pin) constraints.push(`node.id==${pin}`);
  // A pin already implies "not the avoided node"; only add the anti-affinity
  // when the member is free-floating (replicas), and never contradict the pin.
  if (avoid && !pin) constraints.push(`node.id!=${avoid}`);

  const placement: Placement = {
    ...(spec.placement ?? {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    // One task per node: tasks of the same service on one node would share the
    // node-local data volume (two postmasters on one PGDATA = corruption).
    ...(dataVolume ? { maxReplicasPerNode: 1 } : {}),
  };
  if (constraints.length === 0) delete placement.constraints;

  return { ...spec, mounts: outMounts, placement };
}

/**
 * A managed Postgres member spec, fully derived: storage from its labels
 * ({@link applyDbStorage}) + the swarmy boot layer (`applyPgBoot`: entrypoint
 * command + PGDATA). Use this — not a bare `applyDbStorage` — for every
 * Postgres member spec, so no rebuild can drop the entrypoint.
 */
export function applyPgMember<S extends StorageSpecLike & PgBootSpecLike & PgCredentialSpecLike>(
  spec: S,
  labels: Record<string, string> | undefined,
): S {
  // Credential: the password secret file (never plaintext env) — see applyPgCredential.
  return applyPgBoot(applyPgCredential(applyDbStorage(spec, labels), labels));
}

/** One mount as reported by the agent (service spec or container inspect). */
export interface ObservedMount {
  type?: string;
  /** Volume name / bind source. Anonymous volumes report their hash name. */
  source?: string;
  target: string;
}

export type DbStorageStateKind = 'persistent' | 'unmounted' | 'unknown';

export interface DbStorageState {
  state: DbStorageStateKind;
  /** The volume the data lives on (persistent). */
  dataVolume?: string;
  /** Docker swarm node id the member is pinned to, when declared. */
  pinnedNode?: string;
  /** Mounted but not yet declared on labels (pre-label PITR `dataVolume`) — adopt it. */
  undeclared?: boolean;
  /** Plain-words explanation for the dashboard (non-persistent states). */
  message?: string;
}

export const UNMOUNTED_MESSAGE =
  'Data is not on a persistent volume — a restart, update or reschedule starts an EMPTY database. Back up, then click Migrate storage.';
export const UNKNOWN_STORAGE_MESSAGE =
  "Can't verify this database's storage: the node agent is too old to report mounts. Update the agent.";

/**
 * Classify a Postgres member's storage from live truth.
 *
 * `mounts` undefined = the agent predates mount reporting: fall back to the
 * declared label (new-layout members always carry it) and otherwise report
 * `unknown` rather than a false alarm. A declared label whose mount is missing
 * from live truth (a bare rebuild dropped it) is `unmounted`: the live writer
 * is on an anonymous volume and must be migrated, never silently redeployed.
 */
export function dbStorageState(svc: {
  labels: Record<string, string>;
  mounts?: readonly ObservedMount[] | undefined;
}): DbStorageState {
  const declared = svc.labels[DB_DATA_VOLUME_LABEL];
  const pinnedNode = svc.labels[DB_PIN_NODE_LABEL];
  const pin = pinnedNode ? { pinnedNode } : {};
  if (svc.mounts === undefined) {
    return declared
      ? { state: 'persistent', dataVolume: declared, ...pin }
      : { state: 'unknown', ...pin, message: UNKNOWN_STORAGE_MESSAGE };
  }
  const data = svc.mounts.find(
    (m) =>
      (m.target === MANAGED_PG_ROOT || m.target === MANAGED_PG_PGDATA) &&
      (m.type === undefined || m.type === 'volume' || m.type === 'bind') &&
      Boolean(m.source),
  );
  if (!data) return { state: 'unmounted', ...pin, message: UNMOUNTED_MESSAGE };
  return {
    state: 'persistent',
    dataVolume: data.source!,
    ...pin,
    ...(declared !== data.source ? { undeclared: true } : {}),
  };
}

/** A swarm node as far as primary placement cares. */
export interface PinCandidateNode {
  swarmNodeId: string;
  role: 'manager' | 'worker';
  availability: 'active' | 'pause' | 'drain';
  status: 'unknown' | 'down' | 'ready' | 'disconnected';
  /** Swarm node labels — `swarmy.disk.default` marks a node with an added data disk. */
  labels?: Record<string, string>;
}

export interface PinChoiceInput {
  nodes: readonly PinCandidateNode[];
  /** swarm node id → number of primaries already pinned there. */
  pinnedCounts: ReadonlyMap<string, number>;
  fallback?: string;
  /**
   * Swarm node ids whose DECLARED default data disk is not really mounted
   * right now (formatted but not attached on the host — QA-075b). New data
   * there would have nowhere safe to go, so these nodes are skipped.
   */
  unmountedDefaultDisk?: ReadonlySet<string>;
}

export interface PinChoice {
  node: string | undefined;
  /** Why some nodes were passed over (plain words), when any were. */
  note?: string;
  /** Set when NO node is eligible: the placement must be refused with this message. */
  refusal?: string;
}

/**
 * Choose the node a NEW primary is pinned to, and say why when nodes were
 * skipped. Pure. Among schedulable (ready + active) nodes it prefers, in
 * order: a node with a default data disk (`swarmy.disk.default`, so the data
 * lands on the added disk and not the root disk — QA-076), the fewest existing
 * pinned primaries, `fallback` (the manager the controller dispatches
 * through), managers, then id order for determinism. A node whose declared
 * default disk is not mounted ({@link PinChoiceInput.unmountedDefaultDisk})
 * is skipped; only when every schedulable node is skipped is it a refusal.
 * With no usable inventory it returns `fallback`.
 */
export function explainPinNode(input: PinChoiceInput): PinChoice {
  const usable = input.nodes.filter((n) => n.status === 'ready' && n.availability === 'active');
  if (usable.length === 0) return { node: input.fallback };
  const broken = (n: PinCandidateNode) =>
    Boolean(input.unmountedDefaultDisk?.has(n.swarmNodeId)) && defaultDiskMount(n.labels) !== null;
  const skipped = usable.filter(broken).map((n) => n.swarmNodeId);
  const eligible = usable.filter((n) => !broken(n));
  if (eligible.length === 0) {
    return {
      node: undefined,
      refusal:
        `no server can take the data right now: the data disk on ${skipped.join(', ')} is set up but not attached, ` +
        'so new data would land on the root disk. swarmy re-attaches it within a few minutes (see the server\'s Disks card) — try again then.',
    };
  }
  const load = (id: string) => input.pinnedCounts.get(id) ?? 0;
  const disk = (n: PinCandidateNode) => Number(defaultDiskMount(n.labels) !== null);
  const sorted = [...eligible].sort(
    (a, b) =>
      disk(b) - disk(a) ||
      load(a.swarmNodeId) - load(b.swarmNodeId) ||
      Number(b.swarmNodeId === input.fallback) - Number(a.swarmNodeId === input.fallback) ||
      Number(b.role === 'manager') - Number(a.role === 'manager') ||
      a.swarmNodeId.localeCompare(b.swarmNodeId),
  );
  const node = sorted[0]!.swarmNodeId;
  return skipped.length
    ? { node, note: `placed on ${node}: skipped ${skipped.join(', ')} because its data disk is set up but not attached` }
    : { node };
}

/** {@link explainPinNode}, node only (undefined also when every node was skipped). */
export function choosePinNode(input: PinChoiceInput): string | undefined {
  return explainPinNode(input).node;
}

/** Count pinned primaries per swarm node off live service labels. */
export function pinnedPrimaryCounts(
  services: ReadonlyArray<{ labels: Record<string, string> }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of services) {
    if (s.labels['swarmy.db.role'] !== 'primary') continue;
    const pin = s.labels[DB_PIN_NODE_LABEL];
    if (pin) out.set(pin, (out.get(pin) ?? 0) + 1);
  }
  return out;
}

/** Marker the basebackup script prints on a verified copy (the controller checks it). */
export const BASEBACKUP_OK_MARKER = 'SWARMY_PGDATA_OK';

/**
 * The one-shot ONLINE copy that seeds a legacy primary's named volume
 * (mounted at the data root `/var/lib/postgresql/data`) from the RUNNING
 * primary with `pg_basebackup` over the cluster overlay — the primary keeps
 * serving and is never stopped. Runs as root in the primary's OWN image (so
 * pg_basebackup matches the server major), reading `SRC_HOST` / `PGUSER` from
 * env and the replication credential from a 0600 `PGPASSFILE` the controller
 * puts into the container before it starts (never env, never argv).
 *
 * - Anything already in the volume (a previous failed attempt) is moved aside
 *   to `.swarmy-premigrate-<stamp>`, never deleted.
 * - `-X stream` makes the copy self-consistent (backup_label + WAL kept, so the
 *   first start crash-recovers to the backup end point).
 * - `standby.signal`/`recovery.signal` are removed (this copy becomes the
 *   WRITER — the boot layer never removes them itself), and a
 *   `default_transaction_read_only` the migration's write-freeze put in
 *   `postgresql.auto.conf` is stripped so the new primary starts writable.
 * - Ownership → the image's `postgres` user, PGDATA mode 0700.
 *
 * The official entrypoint treats a PGDATA with `PG_VERSION` as existing data
 * (no initdb), and the swarmy boot layer re-asserts its includes + pg_hba rule
 * on start, so a basebackup PGDATA boots as-is. Exits non-zero unless
 * `pgdata/PG_VERSION` exists; prints {@link BASEBACKUP_OK_MARKER} on success.
 */
export function storageBasebackupScript(stamp: string): string {
  const R = MANAGED_PG_ROOT;
  const D = MANAGED_PG_PGDATA;
  const aside = `${R}/.swarmy-premigrate-${stamp}`;
  return [
    'set -eu',
    'if [ -z "${SRC_HOST:-}" ] || [ -z "${PGUSER:-}" ] || { [ -z "${PGPASSWORD:-}" ] && [ ! -s "${PGPASSFILE:-/nonexistent}" ]; }; then echo "missing replication credentials"; exit 2; fi',
    `if [ -n "$(ls -A ${R} 2>/dev/null)" ]; then mkdir -p ${aside}; ` +
      `for f in ${R}/* ${R}/.[!.]*; do [ -e "$f" ] || continue; case "$f" in ${R}/.swarmy-premigrate-*) continue;; esac; ` +
      `mv "$f" ${aside}/; done; fi`,
    `mkdir -p ${D}`,
    `pg_basebackup -h "$SRC_HOST" -p 5432 -U "$PGUSER" -w -D ${D} -X stream -c fast -P`,
    `test -f ${D}/PG_VERSION || { echo "basebackup verification failed (pgdata/PG_VERSION missing)"; exit 4; }`,
    `rm -f ${D}/standby.signal ${D}/recovery.signal ${D}/postmaster.pid`,
    `if [ -f ${D}/postgresql.auto.conf ]; then sed -i '/^[[:space:]]*default_transaction_read_only[[:space:]]*=/d' ${D}/postgresql.auto.conf; fi`,
    `chown -R postgres:postgres ${R}`,
    `chmod 700 ${D}`,
    `echo "${BASEBACKUP_OK_MARKER} pg=$(cat ${D}/PG_VERSION) kb=$(du -sk ${D} | cut -f1)"`,
  ].join('\n');
}
