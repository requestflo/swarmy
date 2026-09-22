/**
 * Managed Postgres STORAGE layout — the one pure source of truth shared by the
 * controller (`@swarmy/trpc` manageddb.service / dbBackup.service) and the
 * manageddb-reconcile worker (which cannot subpath-import trpc internals).
 *
 * Why this exists: clusters used to be deployed with NO mounts, so the bitnami
 * image's `VOLUME /bitnami/postgresql` landed in an anonymous volume and any task
 * restart / reschedule / drain / image update started an EMPTY database. The
 * layout is now:
 *
 *   primary  → named local volume `<stack>_<cluster>-primary-data` mounted at
 *              `/bitnami/postgresql`, pinned to ONE swarm node
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
 * live labels via {@link applyDbStorage} instead of rebuilding a bare spec.
 */

/** Bitnami persistence root (the image's VOLUME). PGDATA is `<root>/data`. */
export const BITNAMI_PG_ROOT = '/bitnami/postgresql';

/** Named volume this member's `/bitnami/postgresql` lives on. */
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
 * `/bitnami/postgresql` target over any other mount for that path. No storage
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
      { type: 'volume', source: dataVolume, target: BITNAMI_PG_ROOT },
      ...mounts.filter((m) => m.target !== BITNAMI_PG_ROOT),
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
      (m.target === BITNAMI_PG_ROOT || m.target === `${BITNAMI_PG_ROOT}/data`) &&
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
}

/**
 * Choose the node a NEW primary is pinned to. Pure. Prefers schedulable
 * (ready + active) nodes hosting the fewest existing pinned primaries; ties go
 * to `fallback` (the manager the controller dispatches through), then managers,
 * then id order for determinism. With no usable inventory it returns `fallback`.
 */
export function choosePinNode(input: {
  nodes: readonly PinCandidateNode[];
  /** swarm node id → number of primaries already pinned there. */
  pinnedCounts: ReadonlyMap<string, number>;
  fallback?: string;
}): string | undefined {
  const usable = input.nodes.filter((n) => n.status === 'ready' && n.availability === 'active');
  if (usable.length === 0) return input.fallback;
  const load = (id: string) => input.pinnedCounts.get(id) ?? 0;
  const sorted = [...usable].sort(
    (a, b) =>
      load(a.swarmNodeId) - load(b.swarmNodeId) ||
      Number(b.swarmNodeId === input.fallback) - Number(a.swarmNodeId === input.fallback) ||
      Number(b.role === 'manager') - Number(a.role === 'manager') ||
      a.swarmNodeId.localeCompare(b.swarmNodeId),
  );
  return sorted[0]!.swarmNodeId;
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

/** Bitnami's non-root postgres uid (image `USER 1001`, group root). */
export const BITNAMI_PG_UID = '1001';
/** Marker the basebackup script prints on a verified copy (the controller checks it). */
export const BASEBACKUP_OK_MARKER = 'SWARMY_PGDATA_OK';

/**
 * The one-shot ONLINE copy that seeds a legacy primary's named volume
 * (mounted at `/bitnami/postgresql`) from the RUNNING primary with
 * `pg_basebackup` over the cluster overlay — the primary keeps serving and is
 * never stopped. Runs as root in the primary's OWN image (so pg_basebackup
 * matches the server major), reading `SRC_HOST` / `PGUSER` / `PGPASSWORD` from
 * container env (the replication credential never rides argv).
 *
 * - Anything already in the volume (a previous failed attempt) is moved aside
 *   to `.swarmy-premigrate-<stamp>`, never deleted.
 * - `-X stream` makes the copy self-consistent (backup_label + WAL kept, so the
 *   first start crash-recovers to the backup end point).
 * - `standby.signal`/`recovery.signal` are removed (this copy becomes the
 *   WRITER; bitnami also clears them on start), and a
 *   `default_transaction_read_only` the migration's write-freeze put in
 *   `postgresql.auto.conf` is stripped so the new primary starts writable.
 * - `conf/conf.d` is recreated (bitnami's mounted-conf dir; an empty volume is
 *   not seeded from the image once we have written to it).
 * - Ownership → bitnami's uid 1001 (group root), PGDATA mode 0700.
 *
 * bitnami treats a non-empty PGDATA as "persisted data" (no initdb, users not
 * re-created) and regenerates postgresql.conf/pg_hba.conf in its own conf dir
 * from env, so a basebackup PGDATA boots as-is. Exits non-zero unless
 * `data/PG_VERSION` exists; prints {@link BASEBACKUP_OK_MARKER} on success.
 */
export function storageBasebackupScript(stamp: string): string {
  const R = BITNAMI_PG_ROOT;
  const aside = `${R}/.swarmy-premigrate-${stamp}`;
  return [
    'set -eu',
    'if [ -z "${SRC_HOST:-}" ] || [ -z "${PGUSER:-}" ] || [ -z "${PGPASSWORD:-}" ]; then echo "missing replication credentials"; exit 2; fi',
    `if [ -n "$(ls -A ${R} 2>/dev/null)" ]; then mkdir -p ${aside}; ` +
      `for f in ${R}/* ${R}/.[!.]*; do [ -e "$f" ] || continue; case "$f" in ${R}/.swarmy-premigrate-*) continue;; esac; ` +
      `mv "$f" ${aside}/; done; fi`,
    `mkdir -p ${R}/data ${R}/conf/conf.d`,
    `pg_basebackup -h "$SRC_HOST" -p 5432 -U "$PGUSER" -w -D ${R}/data -X stream -c fast -P`,
    `test -f ${R}/data/PG_VERSION || { echo "basebackup verification failed (data/PG_VERSION missing)"; exit 4; }`,
    `rm -f ${R}/data/standby.signal ${R}/data/recovery.signal ${R}/data/postmaster.pid`,
    `if [ -f ${R}/data/postgresql.auto.conf ]; then sed -i '/^[[:space:]]*default_transaction_read_only[[:space:]]*=/d' ${R}/data/postgresql.auto.conf; fi`,
    `chown -R ${BITNAMI_PG_UID}:0 ${R}`,
    `chmod 700 ${R}/data`,
    `echo "${BASEBACKUP_OK_MARKER} pg=$(cat ${R}/data/PG_VERSION) kb=$(du -sk ${R}/data | cut -f1)"`,
  ].join('\n');
}
