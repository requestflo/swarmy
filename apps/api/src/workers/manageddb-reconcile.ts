import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import type { OrgContext } from '@swarmy/trpc';
import {
  DB_DATA_VOLUME_LABEL,
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  DB_PIN_NODE_LABEL,
  STACK_LABEL,
  MANAGED_PG_ROOT,
  PG_ENV,
  PG_PROMOTE_SQL,
  applyPgMember,
  pgBootRole,
  pgPrimaryEnv,
  pgReplicaEnv,
  choosePinNode,
  DB_SWITCHOVER_LABEL,
  decideFailover,
  switchoverRequested,
  encodePendingFailover,
  parseFailoverConfirmation,
  parsePendingFailover,
  pendingFailoverChanged,
  type FailoverCandidate,
  type PrimaryWatermark,
  dbStorageLabels,
  dbStorageState,
  extraPrimaryDataVolumeName,
  pinnedPrimaryCounts,
  regionReplicaDataVolumeName,
} from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import {
  MANAGED_PG_PITR_CONF_TARGET,
  DEFAULT_WALG_IMAGE,
  WAL_ARCHIVE_MOUNT,
  pitrExtraConf,
} from '@swarmy/core/protocol';
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';
import {
  PROMOTION_GRACE_TICKS,
  lagLabelUpdates,
  lsnDiffBytes,
  minuteDue,
  parseLagOutput,
  pinnedRegionFit,
  planClusterStorage,
  parseScheduleLite,
  pitrVersion,
  promotionDue,
  renderWalCredsEnv,
  shipperScript,
} from './manageddb-reconcile.core';

/**
 * Managed DB HA-topology reconcile worker (epic #8 + slice A2 pitr-ha).
 *
 * Every ~15s, for each org, read the managed-DB clusters off the LIVE inventory
 * (services carrying `swarmy.db.engine` + `swarmy.db.cluster`) and CONVERGE each
 * cluster's live member set to its declared HA topology (`swarmy.db.topology`).
 * Pure Docker-truth: reads the hub snapshot, dispatches to the org's manager;
 * Prisma is touched only for the org's `BackupTarget` S3 credentials (vault) and
 * the alert/incident contract rows.
 *
 *   single          → one writer, replica service parked at 0.
 *   primary-replica → 1 writer + N async read replicas (the existing behaviour;
 *                     missing topology label defaults here, so legacy clusters are
 *                     untouched).
 *   failover        → primary-replica + a single-node etcd consensus member
 *                     (`-dcs`) as the election substrate, and the observed leader
 *                     reflected back as `swarmy.db.leader`.
 *   geo             → write-region primary (pinned to `swarmy.region==<region>`)
 *                     + per-region read-replica siblings materialised from
 *                     `swarmy.db.region.<region>.replicas`.
 *   active-active   → `swarmy.db.primaries` writable primaries (bidirectional
 *                     logical replication is an engine concern — see caveat).
 *
 * Slice A2 adds, per cluster per tick:
 *
 *   PITR / WAL archiving — when the primary carries `swarmy.db.backup.pitr=true`
 *   (stamped by dbBackup.service#setSchedule): ensure a `<base>-wal-archive`
 *   volume on the primary, a Docker config enabling `archive_mode=on` +
 *   the idempotent cp `archive_command` (mounted in the conf dir swarmy's boot
 *   layer includes — @swarmy/core manageddb-pg), and a
 *   per-cluster `<base>-wal-shipper` sidecar service (wal-g image) that loops
 *   `wal-g wal-push`ing archived segments to the cluster's BackupTarget S3
 *   prefix (the SAME `WALG_S3_PREFIX` the `db.backup` wal-g base backups use, so
 *   a `pitr` restore replays this WAL) then deletes them locally. S3 creds ride
 *   a Docker secret (`/run/secrets/wal-creds`), never service env. Application
 *   is one-shot via the `swarmy.db.pitr.applied=<version>` marker — steady state
 *   never redeploys. Caveat: the archive volume is node-local; the shipper is
 *   co-located via the primary's region pin when present (single-node swarms and
 *   region-pinned clusters are exact; free-floating multi-node primaries need a
 *   shared volume driver).
 *
 *   Lag telemetry — exec `psql` inside each running replica container:
 *   `pg_last_xact_replay_timestamp()` seconds behind + replay LSN, plus the
 *   primary's `pg_current_wal_lsn()` for the byte diff. Stamped as
 *   `swarmy.db.lag.<member>=<seconds>` labels on the primary (only when
 *   changed) and `swarmy.db.leader` — surfaced in DbClusterView/db-cluster-panel.
 *
 *   Failover promotion — a primary observed unhealthy for more than
 *   `PROMOTION_GRACE_TICKS` consecutive ticks (module-level map, no DB) goes
 *   through `decideFailover` (@swarmy/core manageddb-failover): a replica is
 *   auto-promoted ONLY when its replay LSN reached the primary's last known
 *   flushed LSN (the watermark sampled on the last healthy tick). Otherwise the
 *   worker stamps the data-loss window as `swarmy.db.failover.pending`, raises a
 *   critical alert + incident, and waits for an admin confirmation
 *   (`swarmy.db.failover.confirm`, written by `manageddb.confirmFailover`).
 *   Promotion itself: exec `SELECT pg_promote()` via psql,
 *   verify `pg_is_in_recovery()=f`, flip `swarmy.db.role` labels (labels-only —
 *   the promoted task keeps its promoted in-memory state), repoint every other
 *   member's `SWARMY_PG_PRIMARY_HOST` under a fresh `SWARMY_PG_REJOIN` epoch
 *   (redeploy specs; the boot layer re-points standbys and moves a demoted
 *   ex-writer's data ASIDE before re-cloning — never deletes it), then
 *   `recordIncidentEvent` + `fireEvent` + `writeAudit`. The promoted service
 *   keeps its replica-role env (not redeployed); its boot layer sees writer
 *   data with no new epoch and keeps starting it as a writer, and the PITR
 *   convergence skips replica-env primaries (a PITR redeploy would restart it).
 *
 *   Scheduled backups — once per minute the worker calls A1's
 *   `runDueDbBackups(now, deps)` seam so `swarmy.db.backup.schedule` labels fire.
 *
 * Storage (the persistent layout — see @swarmy/core manageddb-storage): every
 * spec this worker rebuilds re-derives the member's data mount + node pin /
 * anti-affinity from its `swarmy.db.dataVolume|node|avoidNode` labels via
 * `applyPgMember` (storage + the swarmy boot layer) — never a bare spec. A LEGACY primary (data on an anonymous
 * volume) is never redeployed here (that would start it empty): the tick fires
 * a `db-storage` warning and the operator runs `db.migrateStorage`. A mounted
 * but undeclared primary (pre-label PITR `dataVolume`) is adopted (labels
 * stamped, pinned to the node it runs on); legacy replicas are converged onto
 * the per-node volume + anti-affinity (safe: a replica re-syncs).
 *
 * The label scheme is mirrored from `@swarmy/trpc` manageddb.service.ts /
 * dbBackup.service.ts — a worker cannot subpath-import an internal trpc module
 * (same constraint the region/geodns reconcile workers document), so the
 * constants are inlined and kept in sync.
 */

const TICK_MS = 15_000;

// ── Label scheme — kept in sync with @swarmy/trpc manageddb.service.ts. ──
const DB_ENGINE_LABEL = 'swarmy.db.engine';
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_REPLICAS_LABEL = 'swarmy.db.replicas';
const DB_TOPOLOGY_LABEL = 'swarmy.db.topology';
const DB_WRITE_REGION_LABEL = 'swarmy.db.writeRegion';
const DB_PLACED_REGION_LABEL = 'swarmy.db.placedRegion';
const DB_REGION_LABEL = 'swarmy.db.region';
const DB_PRIMARIES_LABEL = 'swarmy.db.primaries';
const DB_MEMBER_LABEL = 'swarmy.db.member';
const DB_LEADER_LABEL = 'swarmy.db.leader';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
const REGION_NODE_LABEL = 'swarmy.region';
const DB_REGION_REPLICAS_RE = /^swarmy\.db\.region\.(.+)\.replicas$/;
// A2 (mirrors manageddb.service.ts / dbBackup.service.ts):
const DB_PITR_APPLIED_LABEL = 'swarmy.db.pitr.applied';
const DB_WAL_SHIPPER_LABEL = 'swarmy.db.walShipper';
const DB_BACKUP_PITR_LABEL = 'swarmy.db.backup.pitr';
const DB_BACKUP_SCHEDULE_LABEL = 'swarmy.db.backup.schedule';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

const PG_PORT = 5432;
const REPLICATION_USER = 'repl';
const DEFAULT_DATABASE = 'app';
/**
 * Election substrate for `failover` — a Patroni/Stolon image talks to this.
 * The etcd project's own release image (gcr.io/etcd-development is the
 * primary registry in etcd's release docs; multi-arch), configured by etcd's
 * native `ETCD_*` env flags — no vendor repackaging.
 */
const ETCD_IMAGE = 'gcr.io/etcd-development/etcd:v3.5.21';

const EXEC_TIMEOUT_MS = 15_000;
const PROMOTE_TIMEOUT_MS = 30_000;

type DbTopology = 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';
const TOPOLOGIES: readonly string[] = [
  'single',
  'primary-replica',
  'failover',
  'geo',
  'active-active',
];
const DEFAULT_TOPOLOGY: DbTopology = 'primary-replica';

/** Env `KEY=value` strings → a spec env record. */
function envRecord(env: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

function topologyOf(labels: Record<string, string> | undefined): DbTopology {
  const v = labels?.[DB_TOPOLOGY_LABEL];
  return v && TOPOLOGIES.includes(v) ? (v as DbTopology) : DEFAULT_TOPOLOGY;
}

function parseRegionReplicas(labels: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(labels)) {
    const m = DB_REGION_REPLICAS_RE.exec(key);
    if (!m) continue;
    const region = m[1];
    const n = Number.parseInt(value, 10);
    if (!region || Number.isNaN(n) || n < 0) continue;
    out.set(region, n);
  }
  return out;
}

interface Cluster {
  stack: string;
  cluster: string;
  /** `<stack>_<cluster>` — sibling service names derive from this. */
  base: string;
  primary?: SwarmServiceInfo;
  /** Base (unregioned) read-replica service. */
  replica?: SwarmServiceInfo;
  /** failover consensus member. */
  dcs?: SwarmServiceInfo;
  /** PITR wal-shipper sidecar (A2). */
  shipper?: SwarmServiceInfo;
  /** active-active: index (>=2) → extra primary service. */
  extraPrimaries: Map<number, SwarmServiceInfo>;
  /** geo: region → region-pinned replica sibling. */
  regionReplicas: Map<string, SwarmServiceInfo>;
}

/** Common labels every materialised DB member carries (kept warm, Docker-truth). */
function memberLabels(
  cluster: Cluster,
  role: 'primary' | 'replica' | 'dcs',
  topology: DbTopology,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: cluster.stack,
    [DB_ENGINE_LABEL]: 'postgres',
    [DB_CLUSTER_LABEL]: cluster.cluster,
    [DB_ROLE_LABEL]: role,
    [DB_TOPOLOGY_LABEL]: topology,
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    ...extra,
  };
}

const clusterNet = (c: Cluster) => `${c.base}-net`;

/** etcd DCS member — the consensus store a Patroni-style supervisor would use. */
function dcsSpec(c: Cluster): ServiceSpec {
  const name = `${c.base}-dcs`;
  return {
    name,
    image: ETCD_IMAGE,
    mode: { replicated: { replicas: 1 } },
    command: ['/usr/local/bin/etcd'],
    env: {
      ETCD_NAME: name,
      ETCD_DATA_DIR: '/etcd-data',
      ETCD_LISTEN_CLIENT_URLS: 'http://0.0.0.0:2379',
      ETCD_ADVERTISE_CLIENT_URLS: `http://${name}:2379`,
    },
    labels: memberLabels(c, 'dcs', 'failover'),
    networks: [clusterNet(c)],
  };
}

/** A region-pinned streaming read replica (geo). Mirrors region-reconcile placement. */
function regionReplicaSpec(
  c: Cluster,
  primary: SwarmServiceInfo,
  region: string,
  n: number,
  multiNode: boolean,
): ServiceSpec {
  const env = envRecord(primary.env ?? []);
  const password = env[PG_ENV.password] ?? '';
  const pin = primary.labels[DB_PIN_NODE_LABEL];
  const labels = memberLabels(c, 'replica', 'geo', {
    [DB_REGION_LABEL]: region,
    [DB_REPLICAS_LABEL]: String(n),
    ...dbStorageLabels({
      dataVolume: regionReplicaDataVolumeName(c.base, region),
      ...(multiNode && pin ? { avoidNode: pin } : {}),
    }),
  });
  return applyPgMember<ServiceSpec>({
    name: `${c.base}-replica-${region}`,
    image: primary.image,
    mode: { replicated: { replicas: n } },
    env: pgReplicaEnv({
      password,
      replicationUser: env[PG_ENV.replicationUser] ?? REPLICATION_USER,
      replicationPassword: env[PG_ENV.replicationPassword] ?? password,
      primaryHost: primary.name,
      primaryPort: PG_PORT,
    }),
    labels,
    networks: [clusterNet(c)],
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  }, labels);
}

/** An additional writable primary (active-active). */
function extraPrimarySpec(
  c: Cluster,
  primary: SwarmServiceInfo,
  index: number,
  pinNode: string | undefined,
): ServiceSpec {
  const env = envRecord(primary.env ?? []);
  const labels = memberLabels(c, 'primary', 'active-active', {
    [DB_MEMBER_LABEL]: String(index),
    ...dbStorageLabels({ dataVolume: extraPrimaryDataVolumeName(c.base, index), pinNode }),
  });
  return applyPgMember<ServiceSpec>({
    name: `${c.base}-primary-${index}`,
    image: primary.image,
    mode: { replicated: { replicas: 1 } },
    env: pgPrimaryEnv({
      password: env[PG_ENV.password] ?? '',
      database: env[PG_ENV.database] ?? DEFAULT_DATABASE,
      replicationUser: env[PG_ENV.replicationUser] ?? REPLICATION_USER,
      replicationPassword: env[PG_ENV.replicationPassword] ?? env[PG_ENV.password] ?? '',
    }),
    labels,
    networks: [clusterNet(c)],
  }, labels);
}

/**
 * Re-place the primary onto a node in `region` (geo). Rebuilt from live truth
 * (image + env + networks + labels) with a region-pinning placement constraint,
 * and stamps `swarmy.db.placedRegion` so this is a one-shot per write-region
 * change (steady state diffs equal → no redeploy). The data mount + node pin
 * are re-derived from the storage labels (the caller only re-places when the
 * pinned node is IN the write region — a node-local volume cannot move).
 */
function placePrimarySpec(primary: SwarmServiceInfo, region: string, net: string): ServiceSpec {
  const networks = (primary.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const labels = { ...primary.labels, [DB_PLACED_REGION_LABEL]: region };
  return applyPgMember<ServiceSpec>({
    name: primary.name,
    image: primary.image,
    mode: { replicated: { replicas: primary.desiredReplicas ?? 1 } },
    env: envRecord(primary.env ?? []),
    labels,
    networks: networks.length > 0 ? networks : [net],
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  }, labels);
}

/** Base read-replica rebuilt from live truth with its storage re-derived from `labels`. */
function replicaStorageSpec(replica: SwarmServiceInfo, labels: Record<string, string>, net: string): ServiceSpec {
  const networks = (replica.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  return applyPgMember<ServiceSpec>(
    {
      name: replica.name,
      image: replica.image,
      mode: { replicated: { replicas: replica.desiredReplicas ?? 0 } },
      env: envRecord(replica.env ?? []),
      labels,
      networks: networks.length > 0 ? networks : [net],
      ...((replica.secrets ?? []).length > 0
        ? { secrets: (replica.secrets ?? []).map((n) => ({ source: n })) }
        : {}),
    },
    labels,
  );
}

/** `${orgId}/${stack}/${cluster}` clusters currently warned for legacy storage
 *  (module-level: the alert fires once per episode, resolves when fixed). */
const legacyWarned = new Set<string>();
/** `${warnKey}/${region}` geo re-placements refused because the data is pinned elsewhere. */
const regionMismatchWarned = new Set<string>();

// ── @swarmy/trpc contract seams (lazy) ────────────────────────────────────────
// Loaded on first use rather than at module load, so this worker's pure-helper
// unit tests never evaluate the whole tRPC router graph, and a broken sibling
// router can't take the reconcile module down with it.

type TrpcSeams = typeof import('@swarmy/trpc');

let seamsCache: TrpcSeams | null = null;
async function loadSeams(): Promise<TrpcSeams | null> {
  if (seamsCache) return seamsCache;
  try {
    seamsCache = await import('@swarmy/trpc');
  } catch {
    return null;
  }
  return seamsCache;
}

/** The alert/incident/audit contract, bound to one org's system context. */
interface Contract {
  seams: TrpcSeams;
  ctx: OrgContext;
}

// ── A2 live plumbing ──────────────────────────────────────────────────────────

const LAG_SQL =
  "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())),0)::text || '|' || COALESCE(pg_last_wal_replay_lsn()::text,'')";
/** The primary's last FLUSHED position — the failover watermark (see decideFailover). */
const PRIMARY_LSN_SQL = 'SELECT pg_current_wal_flush_lsn()::text';
const IN_RECOVERY_SQL = 'SELECT pg_is_in_recovery()';

function psql(sql: string): string {
  return `PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d postgres -tAc "${sql}"`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Find a running container for the service + the node hosting it (org-scoped). */
function execTarget(
  orgId: string,
  service: SwarmServiceInfo,
): { nodeId: string; containerId: string } | undefined {
  const orgContainerIds = new Set(hub.liveInventory(orgId).containers.map((cc) => cc.id));
  for (const nodeId of hub.onlineNodeIds()) {
    const match = hub.latestContainers(nodeId).find((cc: ContainerInfo) => {
      if (!orgContainerIds.has(cc.id)) return false;
      const sid = cc.serviceId ?? cc.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === service.id && cc.state === 'running';
    });
    if (match) return { nodeId, containerId: match.id };
  }
  return undefined;
}

/** `sh -c <script>` inside one running container of the service; null on failure. */
async function execIn(
  orgId: string,
  service: SwarmServiceInfo,
  script: string,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ exitCode: number; output: string } | null> {
  const target = execTarget(orgId, service);
  if (!target) return null;
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', script],
        tty: false,
        stream: false,
      },
      { timeoutMs },
    );
    return { exitCode: res.exitCode, output: res.output ?? '' };
  } catch {
    return null;
  }
}

/** Replica-role members eligible for lag telemetry + promotion. */
function replicaMembers(c: Cluster): SwarmServiceInfo[] {
  return [c.replica, ...c.regionReplicas.values()].filter(
    (s): s is SwarmServiceInfo => Boolean(s),
  );
}

interface MemberLag {
  lagSeconds: number;
  lsnDiffBytes: number | null;
  /** The replica's replay LSN this tick — the failover caught-up proof. */
  replayLsn: string | null;
}

/** One tick's lag picture + the primary's flushed-LSN sample (null = not taken). */
interface ClusterLag {
  members: Record<string, MemberLag>;
  primaryLsn: string | null;
}

/**
 * Measure replication lag for every replica member and stamp
 * `swarmy.db.lag.<member>` labels onto the primary (change-gated so a steady
 * cluster causes no service updates). Returns the fresh samples for promotion.
 */
async function measureClusterLag(
  orgId: string,
  node: string,
  c: Cluster,
): Promise<ClusterLag> {
  const measured: Record<string, MemberLag> = {};
  const replicas = replicaMembers(c).filter((s) => (s.desiredReplicas ?? 0) > 0);
  if (replicas.length === 0) return { members: measured, primaryLsn: null };

  const primary = c.primary;
  const primaryHealthy = Boolean(primary && (primary.runningReplicas ?? 0) > 0);
  let primaryLsn: string | null = null;
  if (primary && primaryHealthy) {
    const res = await execIn(orgId, primary, psql(PRIMARY_LSN_SQL));
    if (res && res.exitCode === 0) primaryLsn = res.output.trim().split(/\r?\n/)[0]?.trim() || null;
  }

  for (const replica of replicas) {
    const res = await execIn(orgId, replica, psql(LAG_SQL));
    if (!res || res.exitCode !== 0) continue;
    const sample = parseLagOutput(res.output);
    if (!sample) continue;
    measured[replica.name] = {
      lagSeconds: sample.lagSeconds,
      lsnDiffBytes:
        primaryLsn && sample.replayLsn ? lsnDiffBytes(primaryLsn, sample.replayLsn) : null,
      replayLsn: sample.replayLsn,
    };
  }

  // Stamp onto the primary anchor (one read = the whole cluster's lag picture).
  if (primary && Object.keys(measured).length > 0) {
    const memberNames = [primary.name, ...replicaMembers(c).map((s) => s.name)];
    const flat: Record<string, number> = {};
    for (const [name, m] of Object.entries(measured)) flat[name] = m.lagSeconds;
    const update = lagLabelUpdates(primary.labels, flat, memberNames);
    if (update) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: primary.name,
          add: update.add,
          removeKeys: update.removeKeys,
        })
        .catch(() => undefined);
    }
  }
  return { members: measured, primaryLsn };
}

// ── A2 PITR / WAL-archiving convergence ──────────────────────────────────────

interface WalTargetRow {
  id: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
}

/** The cluster's BackupTarget (schedule-pinned, else the org's first enabled). */
async function loadWalTarget(orgId: string, targetId: string | undefined): Promise<WalTargetRow | null> {
  const select = {
    id: true,
    kind: true,
    endpoint: true,
    bucket: true,
    prefix: true,
    region: true,
    credentialRef: true,
    secretKeyRef: true,
  } as const;
  // Targets live in the org's swarm (swarm-kv).
  const seams = await loadSeams();
  if (!seams) return null;
  const targets = seams.backupTargets({ db: prisma, hub }, orgId);
  if (targetId) {
    return (await targets.findFirst({ where: { id: targetId, orgId }, select })) as WalTargetRow | null;
  }
  return (await targets.findFirst({
    where: { orgId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select,
  })) as WalTargetRow | null;
}

/** The PITR-enabled primary spec: archive volume + extended conf + marker. */
function pitrPrimarySpec(
  primary: SwarmServiceInfo,
  c: Cluster,
  version: string,
  dataVolume: string | undefined,
): ServiceSpec {
  const networks = (primary.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const placedRegion = primary.labels[DB_PLACED_REGION_LABEL];
  const confName = `${c.base}-pitr-conf`;
  const labels = { ...primary.labels, [DB_PITR_APPLIED_LABEL]: version };
  // The declared storage volume (applyPgMember below) wins the data root.
  return applyPgMember<ServiceSpec>({
    name: primary.name,
    image: primary.image,
    mode: { replicated: { replicas: primary.desiredReplicas ?? 1 } },
    env: envRecord(primary.env ?? []),
    labels,
    networks: networks.length > 0 ? networks : [clusterNet(c)],
    mounts: [
      { type: 'volume' as const, source: `${c.base}-wal-archive`, target: WAL_ARCHIVE_MOUNT },
      // Physical base backups (wal-g backup-push) need the PGDATA on a named
      // volume; mount it at the data root when the schedule names one.
      ...(dataVolume
        ? [{ type: 'volume' as const, source: dataVolume, target: MANAGED_PG_ROOT }]
        : []),
    ],
    configs: [
      ...(primary.configs ?? []).filter((n) => n !== confName).map((n) => ({ source: n })),
      { source: confName, target: MANAGED_PG_PITR_CONF_TARGET },
    ],
    ...((primary.secrets ?? []).length > 0
      ? { secrets: (primary.secrets ?? []).map((n) => ({ source: n })) }
      : {}),
    ...(placedRegion
      ? { placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${placedRegion}`] } }
      : {}),
  }, labels);
}

/** Primary spec with the PITR bits dropped — the data mount + pin are kept. */
function stripPitrSpec(primary: SwarmServiceInfo, c: Cluster): ServiceSpec {
  const labels = { ...primary.labels };
  delete labels[DB_PITR_APPLIED_LABEL];
  const networks = (primary.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const placedRegion = primary.labels[DB_PLACED_REGION_LABEL];
  return applyPgMember<ServiceSpec>({
    name: primary.name,
    image: primary.image,
    mode: { replicated: { replicas: primary.desiredReplicas ?? 1 } },
    env: envRecord(primary.env ?? []),
    labels,
    networks: networks.length > 0 ? networks : [clusterNet(c)],
    ...(placedRegion
      ? { placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${placedRegion}`] } }
      : {}),
  }, labels);
}

/** The per-cluster wal-shipper sidecar (wal-g loop, creds via Docker secret). */
function walShipperSpec(
  c: Cluster,
  version: string,
  secretName: string,
  primary: SwarmServiceInfo,
): ServiceSpec {
  const placedRegion = primary.labels[DB_PLACED_REGION_LABEL];
  // The archive volume is node-local: follow the primary's node pin exactly.
  const pin = primary.labels[DB_PIN_NODE_LABEL];
  const constraints = [
    ...(placedRegion ? [`node.labels.${REGION_NODE_LABEL}==${placedRegion}`] : []),
    ...(pin ? [`node.id==${pin}`] : []),
  ];
  return {
    name: `${c.base}-wal-shipper`,
    image: DEFAULT_WALG_IMAGE,
    mode: { replicated: { replicas: 1 } },
    command: ['/bin/sh', '-c', shipperScript()],
    labels: {
      [MANAGED_LABEL]: 'true',
      [STACK_LABEL]: c.stack,
      [DB_CLUSTER_LABEL]: c.cluster,
      [DB_WAL_SHIPPER_LABEL]: 'true',
      [DB_PITR_APPLIED_LABEL]: version,
      [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    },
    mounts: [{ type: 'volume' as const, source: `${c.base}-wal-archive`, target: WAL_ARCHIVE_MOUNT }],
    secrets: [{ source: secretName, target: 'wal-creds' }],
    networks: [clusterNet(c)],
    ...(constraints.length > 0 ? { placement: { constraints } } : {}),
  };
}

/** Create a Docker secret/config, tolerating "already exists" (immutable objects). */
async function createSwarmObject(
  node: string,
  cmd: 'secret.create' | 'config.create',
  name: string,
  content: string,
  labels: Record<string, string>,
): Promise<void> {
  try {
    await hub.dispatch(node, cmd, {
      name,
      dataB64: Buffer.from(content, 'utf8').toString('base64'),
      labels,
    });
  } catch (e) {
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

/** Best-effort removal of superseded `<base>-wal-creds-*` secrets. */
async function cleanupStaleWalSecrets(node: string, c: Cluster, keep: string): Promise<void> {
  try {
    const res = await hub.dispatch<{ secrets?: Array<{ name: string }> }>(node, 'secret.list', {});
    for (const s of res.secrets ?? []) {
      if (s.name.startsWith(`${c.base}-wal-creds-`) && s.name !== keep) {
        await hub.dispatch(node, 'secret.remove', { name: s.name }).catch(() => undefined);
      }
    }
  } catch {
    // best-effort — an in-use secret refuses removal until its consumer updates.
  }
}

/**
 * Converge one cluster's WAL-archiving wiring to its `swarmy.db.backup.pitr`
 * flag. One-shot via the `swarmy.db.pitr.applied=<version>` marker.
 */
async function ensurePitr(contract: Contract, orgId: string, node: string, c: Cluster): Promise<void> {
  const { ctx, seams } = contract;
  const primary = c.primary;
  const enabled = primary?.labels[DB_BACKUP_PITR_LABEL] === 'true';
  // Never redeploy a primary whose data is not on a persistent volume: the new
  // task would start on a fresh anonymous volume (an EMPTY database).
  const primaryRedeployable = Boolean(primary) && dbStorageState(primary!).state === 'persistent';

  if (!primary || !enabled) {
    // Teardown: drop the shipper; a marked primary is redeployed without the
    // archive bits (live truth carries no mounts/configs, so they fall away).
    if (c.shipper) {
      await hub.dispatch(node, 'service.remove', { service: c.shipper.name }).catch(() => undefined);
    }
    if (primary?.labels[DB_PITR_APPLIED_LABEL] && primaryRedeployable) {
      await hub
        .dispatch(node, 'service.deploy', { spec: stripPitrSpec(primary, c), pullPolicy: 'missing' })
        .catch(() => undefined);
    }
    return;
  }

  // Never redeploy an in-place-promoted primary: its env still says replica, and
  // a PITR redeploy restarts the writer for nothing (its boot layer would keep
  // it a writer, but the archive bits wait for a re-provision as a primary).
  if (pgBootRole(envRecord(primary.env ?? [])) === 'replica') return;
  if (!primaryRedeployable) return; // legacy storage — surfaced as a db-storage warning

  const schedule = parseScheduleLite(primary.labels[DB_BACKUP_SCHEDULE_LABEL]);
  const target = await loadWalTarget(orgId, schedule?.targetId).catch(() => null);
  const resource = `db:${c.stack}/${c.cluster}`;
  if (!target || target.kind.toLowerCase() !== 's3') {
    await seams.fireEvent(ctx, {
      signal: 'db-pitr',
      severity: 'warning',
      resource,
      message: `PITR is enabled for ${c.cluster} but no S3 backup destination is configured — WAL archiving is idle`,
    }).catch(() => undefined);
    return;
  }

  const creds = renderWalCredsEnv({
    endpoint: target.endpoint,
    bucket: target.bucket,
    prefix: target.prefix,
    region: target.region,
    accessKeyId: target.credentialRef ? decryptSecret(target.credentialRef) : null,
    secretAccessKey: target.secretKeyRef ? decryptSecret(target.secretKeyRef) : null,
  });
  // The declared persistent volume wins over a schedule-supplied one.
  const dataVolume = primary.labels[DB_DATA_VOLUME_LABEL] ?? schedule?.dataVolume;
  const version = pitrVersion(creds, dataVolume);
  const secretName = `${c.base}-wal-creds-${version}`;
  const primaryOk = primary.labels[DB_PITR_APPLIED_LABEL] === version;
  const shipperOk = c.shipper?.labels[DB_PITR_APPLIED_LABEL] === version;
  if (primaryOk && shipperOk) return;

  const objectLabels = { [MANAGED_LABEL]: 'true', [DB_CLUSTER_LABEL]: c.cluster };
  await hub
    .dispatch(node, 'network.ensure', {
      name: clusterNet(c),
      driver: 'overlay',
      attachable: true,
      labels: objectLabels,
    })
    .catch(() => undefined);
  await createSwarmObject(node, 'config.create', `${c.base}-pitr-conf`, pitrExtraConf(), objectLabels).catch(
    () => undefined,
  );
  await createSwarmObject(node, 'secret.create', secretName, creds, objectLabels).catch(() => undefined);

  if (!primaryOk) {
    await hub
      .dispatch(node, 'service.deploy', {
        spec: pitrPrimarySpec(primary, c, version, dataVolume),
        pullPolicy: 'missing',
      })
      .catch(() => undefined);
  }
  if (!shipperOk) {
    await hub
      .dispatch(node, 'service.deploy', {
        spec: walShipperSpec(c, version, secretName, primary),
        pullPolicy: 'always',
      })
      .catch(() => undefined);
  }
  await cleanupStaleWalSecrets(node, c, secretName);

  await seams.writeAudit(ctx, {
    action: 'db.pitr.apply',
    actorType: 'system',
    targetType: 'dbCluster',
    targetId: `${c.stack}/${c.cluster}`,
    metadata: { version, targetId: target.id, dataVolume: dataVolume ?? null },
  }).catch(() => undefined);
  await seams.fireEvent(ctx, {
    signal: 'db-pitr',
    severity: 'info',
    resource,
    message: `WAL archiving configured for ${c.cluster}`,
    status: 'resolved',
  }).catch(() => undefined);
}

// ── A2 failover promotion ─────────────────────────────────────────────────────

/** `${orgId}/${stack}/${cluster}` → consecutive ticks the primary was unhealthy.
 *  Module-level on purpose (grace window state; never persisted). */
const unhealthyTicks = new Map<string, number>();
/** `${orgId}/${stack}/${cluster}` → the primary's last flushed-LSN sample while healthy. */
const watermarks = new Map<string, PrimaryWatermark>();
/** `${orgId}/${stack}/${cluster}` → epoch ms the primary was last observed healthy. */
const lastHealthyAt = new Map<string, number>();
/** Clusters whose "failover needs confirmation" alert fired this episode. */
const confirmAlerted = new Set<string>();

/**
 * Spec repointing a replica-role service at the promoted writer. `epoch` is
 * the promotion's rejoin token: a standby just re-points; a member holding
 * WRITER data (the demoted ex-primary) moves it aside and re-clones — see
 * @swarmy/core manageddb-pg.
 */
function repointSpec(s: SwarmServiceInfo, promoted: string, net: string, epoch: string): ServiceSpec {
  const env = envRecord(s.env ?? []);
  const networks = (s.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const region = s.labels[DB_REGION_LABEL];
  const labels: Record<string, string> = {
    ...s.labels,
    [DB_ROLE_LABEL]: 'replica',
    [DB_LEADER_LABEL]: promoted,
  };
  // The failover wait/confirm handshake is over once a writer is promoted.
  delete labels[DB_FAILOVER_PENDING_LABEL];
  delete labels[DB_FAILOVER_CONFIRM_LABEL];
  // A planned switchover (volume mobility) is over once a writer is promoted.
  delete labels[DB_SWITCHOVER_LABEL];
  // A demoted ex-primary loses its PITR marker — its archive bits drop with the
  // redeploy (live truth carries no mounts/configs) and the new writer re-earns
  // them from the PITR convergence.
  delete labels[DB_PITR_APPLIED_LABEL];
  // Storage is carried forward from the member's own labels: the demoted
  // ex-primary keeps its pinned data volume, replicas keep their per-node one.
  const replEnv = pgReplicaEnv({
    password: env[PG_ENV.password] ?? '',
    replicationUser: env[PG_ENV.replicationUser] ?? REPLICATION_USER,
    replicationPassword: env[PG_ENV.replicationPassword] ?? env[PG_ENV.password] ?? '',
    primaryHost: promoted,
    primaryPort: PG_PORT,
    rejoin: epoch,
  });
  return applyPgMember<ServiceSpec>({
    name: s.name,
    image: s.image,
    mode: { replicated: { replicas: s.desiredReplicas ?? 1 } },
    env: { ...env, ...replEnv },
    labels,
    networks: networks.length > 0 ? networks : [net],
    ...((s.secrets ?? []).length > 0 ? { secrets: (s.secrets ?? []).map((n) => ({ source: n })) } : {}),
    ...((s.configs ?? []).length > 0 ? { configs: (s.configs ?? []).map((n) => ({ source: n })) } : {}),
    ...(region ? { placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] } } : {}),
  }, labels);
}

/** exec `SELECT pg_promote()` in one running task + verify recovery ended. */
async function promoteInPlace(orgId: string, svc: SwarmServiceInfo): Promise<boolean> {
  const promote = await execIn(orgId, svc, psql(PG_PROMOTE_SQL), PROMOTE_TIMEOUT_MS);
  if (!promote || promote.exitCode !== 0) return false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const verify = await execIn(orgId, svc, psql(IN_RECOVERY_SQL));
    if (verify && verify.exitCode === 0 && verify.output.trim().startsWith('f')) return true;
    await sleep(2_000);
  }
  return false;
}

/**
 * Watch the primary's health; after the grace window run the failover-safety
 * decision (`decideFailover`): promote a provably caught-up replica, or stamp
 * the data-loss window and wait for an admin confirmation. On promotion flip
 * role labels, repoint the remaining replicas and record the
 * incident/alert/audit trail.
 */
async function maybePromote(
  contract: Contract,
  orgId: string,
  node: string,
  c: Cluster,
  topology: DbTopology,
  lag: ClusterLag,
): Promise<void> {
  const { ctx, seams } = contract;
  const measured = lag.members;
  const key = `${orgId}/${c.stack}/${c.cluster}`;
  const resource = `db:${c.stack}/${c.cluster}`;
  const groupKey = `db:${c.stack}/${c.cluster}`;
  const now = Date.now();

  const primary = c.primary;
  const healthy = Boolean(primary && (primary.runningReplicas ?? 0) > 0);

  // Any member may carry the wait/confirm handshake (the anchor is the primary,
  // or the chosen target when the primary service itself is gone).
  const handshakeHolders = [primary, ...replicaMembers(c)].filter(
    (s): s is SwarmServiceInfo =>
      Boolean(s) &&
      (s!.labels[DB_FAILOVER_PENDING_LABEL] !== undefined || s!.labels[DB_FAILOVER_CONFIRM_LABEL] !== undefined),
  );
  const clearHandshake = async () => {
    for (const s of handshakeHolders) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: s.name,
          add: {},
          removeKeys: [DB_FAILOVER_PENDING_LABEL, DB_FAILOVER_CONFIRM_LABEL],
        })
        .catch(() => undefined);
    }
  };

  // single has nothing to promote; active-active already has other writers.
  if (topology === 'single' || topology === 'active-active') {
    unhealthyTicks.delete(key);
    if (handshakeHolders.length > 0) await clearHandshake();
    return;
  }

  if (healthy) {
    lastHealthyAt.set(key, now);
    if (lag.primaryLsn) watermarks.set(key, { lsn: lag.primaryLsn, sampledAt: now });
    if (handshakeHolders.length > 0) await clearHandshake();
    if (confirmAlerted.delete(key)) {
      await seams.fireEvent(ctx, {
        signal: 'db-failover-confirm',
        severity: 'info',
        resource,
        message: `Primary ${primary!.name} recovered — the pending failover was stood down, no data lost`,
        status: 'resolved',
      }).catch(() => undefined);
    }
    if (unhealthyTicks.delete(key)) {
      await seams.fireEvent(ctx, {
        signal: 'db-degraded',
        severity: 'info',
        resource,
        message: `Primary ${primary!.name} recovered before failover fired`,
        status: 'resolved',
      }).catch(() => undefined);
      await seams.recordIncidentEvent(ctx, {
        groupKey,
        kind: 'db.resolved',
        message: `Primary ${primary!.name} recovered — failover stood down`,
        severity: 'warning',
      }).catch(() => undefined);
    }
    return;
  }

  const ticks = (unhealthyTicks.get(key) ?? 0) + 1;
  unhealthyTicks.set(key, ticks);
  // A PLANNED switchover (the mover stopped a read-only primary on purpose):
  // no grace window and no "unhealthy" alarm — but the promotion below still
  // goes through decideFailover, so a replica that is not provably caught up
  // still holds for confirmation.
  const planned = switchoverRequested(primary?.labels, now);
  if (ticks === 1 && !planned) {
    await seams.fireEvent(ctx, {
      signal: 'db-degraded',
      severity: 'critical',
      resource,
      message: `Primary ${primary?.name ?? c.base} is unhealthy — failover arms after the grace window`,
    }).catch(() => undefined);
    await seams.recordIncidentEvent(ctx, {
      groupKey,
      kind: 'db.degraded',
      message: `Primary ${primary?.name ?? c.base} observed unhealthy (grace window ${PROMOTION_GRACE_TICKS} ticks)`,
      severity: 'critical',
      meta: { cluster: c.cluster, stack: c.stack },
    }).catch(() => undefined);
  }
  if (!planned && !promotionDue(ticks)) return;

  const confirmRaw = handshakeHolders
    .map((s) => s.labels[DB_FAILOVER_CONFIRM_LABEL])
    .find((v): v is string => Boolean(v));
  const confirmation = parseFailoverConfirmation(confirmRaw);
  const candidates: FailoverCandidate[] = replicaMembers(c).map((s) => ({
    service: s.name,
    running: s.runningReplicas ?? 0,
    replayLsn: measured[s.name]?.replayLsn ?? null,
    lagSeconds: measured[s.name]?.lagSeconds ?? null,
  }));
  const decision = decideFailover({
    topology,
    candidates,
    watermark: watermarks.get(key) ?? null,
    lastHealthyAt: lastHealthyAt.get(key) ?? null,
    confirmation,
  });
  if (decision.kind === 'never' || decision.kind === 'wait') return; // keep counting, retry next tick

  if (decision.kind === 'confirm') {
    // Not provably caught up: never promote silently. Stamp the window, alert once.
    const anchor = primary ?? replicaMembers(c).find((s) => s.name === decision.target);
    const prevRaw = handshakeHolders
      .map((s) => s.labels[DB_FAILOVER_PENDING_LABEL])
      .find((v): v is string => Boolean(v));
    const prev = parsePendingFailover(prevRaw);
    const next = {
      target: decision.target,
      behindBytes: decision.behindBytes,
      behindSeconds: decision.behindSeconds,
      reason: decision.reason,
      since: prev?.since || new Date(now).toISOString(),
    };
    if (anchor && pendingFailoverChanged(prev, next)) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: anchor.name,
          add: { [DB_FAILOVER_PENDING_LABEL]: encodePendingFailover(next) },
          removeKeys: [],
        })
        .catch(() => undefined);
    }
    if (!confirmAlerted.has(key)) {
      confirmAlerted.add(key);
      const window =
        decision.behindBytes === null
          ? 'an unknown amount of data'
          : `${decision.behindBytes} bytes${decision.behindSeconds !== null ? ` (~${decision.behindSeconds}s)` : ''}`;
      const message =
        `${c.cluster}: failover is waiting for an admin — promoting ${decision.target} could lose ${window} ` +
        `of the last writes (${decision.reason}). Confirm it on the stack's Data tab, or bring the primary back.`;
      await seams.fireEvent(ctx, {
        signal: 'db-failover-confirm',
        severity: 'critical',
        resource,
        message,
      }).catch(() => undefined);
      await seams.recordIncidentEvent(ctx, {
        groupKey,
        kind: 'db.failover.pending',
        message,
        severity: 'critical',
        meta: { target: decision.target, behindBytes: decision.behindBytes, behindSeconds: decision.behindSeconds, cluster: c.cluster, stack: c.stack },
      }).catch(() => undefined);
      await seams.writeAudit(ctx, {
        action: 'db.failover.held',
        actorType: 'system',
        targetType: 'dbCluster',
        targetId: `${c.stack}/${c.cluster}`,
        metadata: { target: decision.target, behindBytes: decision.behindBytes, behindSeconds: decision.behindSeconds, reason: decision.reason },
      }).catch(() => undefined);
    }
    return;
  }

  const target = replicaMembers(c).find((s) => s.name === decision.target);
  if (!target) return;
  const promoted = await promoteInPlace(orgId, target);
  if (!promoted) return; // exec failed/gated — retry next tick

  const setLabels = (service: string, add: Record<string, string>) =>
    hub.dispatch(node, 'service.updateLabels', { service, add, removeKeys: [] }).catch(() => undefined);

  // Labels-only flips: the promoted task keeps its promoted in-memory state.
  await setLabels(target.name, { [DB_ROLE_LABEL]: 'primary', [DB_LEADER_LABEL]: target.name });
  const others = [primary, ...replicaMembers(c), c.dcs].filter(
    (s): s is SwarmServiceInfo => Boolean(s) && s!.name !== target.name,
  );
  for (const member of others) {
    await setLabels(member.name, {
      [DB_LEADER_LABEL]: target.name,
      ...(member === primary ? { [DB_ROLE_LABEL]: 'replica' } : {}),
    });
  }

  // Repoint every other replica (and the demoted ex-primary) at the new writer.
  const net = clusterNet(c);
  const epoch = `${target.name}@${new Date(now).toISOString()}`;
  const repointed: string[] = [];
  for (const member of others) {
    if (member.labels[DB_ROLE_LABEL] === 'dcs') continue;
    await hub
      .dispatch(node, 'service.deploy', { spec: repointSpec(member, target.name, net, epoch), pullPolicy: 'missing' })
      .catch(() => undefined);
    repointed.push(member.name);
  }

  unhealthyTicks.delete(key);
  watermarks.delete(key);
  lastHealthyAt.delete(key);
  confirmAlerted.delete(key);
  // The ex-primary was redeployed without the handshake labels; clear any other holder.
  await clearHandshake();

  const lagSecs = measured[target.name]?.lagSeconds;
  const lagNote =
    (decision.confirmed
      ? ` — admin-confirmed, accepted window ${decision.behindBytes === null ? 'unknown' : `${decision.behindBytes} bytes`}`
      : ' — provably caught up (0 bytes behind)') + (lagSecs !== undefined ? ` (replica lag ${lagSecs}s)` : '');
  await seams.recordIncidentEvent(ctx, {
    groupKey,
    kind: 'db.failover',
    message: `Promoted ${target.name} to primary${lagNote} after ${ticks} unhealthy ticks`,
    severity: 'critical',
    meta: { promoted: target.name, demoted: primary?.name ?? null, cluster: c.cluster, stack: c.stack },
  }).catch(() => undefined);
  if (repointed.length > 0) {
    await seams.recordIncidentEvent(ctx, {
      groupKey,
      kind: 'db.repoint',
      message: `Repointed ${repointed.join(', ')} at ${target.name}`,
      severity: 'warning',
      meta: { promoted: target.name, repointed },
    }).catch(() => undefined);
  }
  await seams.fireEvent(ctx, {
    signal: 'db-failover',
    severity: 'critical',
    resource,
    message: `${decision.confirmed ? 'Confirmed' : 'Automatic'} failover: ${target.name} promoted to primary of ${c.cluster}${lagNote}`,
  }).catch(() => undefined);
  await seams.writeAudit(ctx, {
    action: 'db.failover.promote',
    actorType: 'system',
    targetType: 'dbCluster',
    targetId: `${c.stack}/${c.cluster}`,
    metadata: {
      promoted: target.name,
      demoted: primary?.name ?? null,
      repointed,
      unhealthyTicks: ticks,
      lagSeconds: lagSecs ?? null,
      behindBytes: decision.behindBytes,
      confirmed: decision.confirmed,
      ...(decision.confirmed && confirmation?.by ? { confirmedBy: confirmation.by } : {}),
    },
  }).catch(() => undefined);
}

// ── A1 scheduled-backup sweep (once per minute) ───────────────────────────────

/** Fire every due managed-DB backup schedule (`dbBackup.service#runDueDbBackups`). */
async function runDueBackupsSweep(now: Date): Promise<void> {
  const seams = await loadSeams();
  if (!seams) return;
  try {
    await seams.runDueDbBackups(now, { db: prisma, hub, auth: authRegistry.getAuth() });
  } catch {
    // best-effort: a failed sweep retries next minute.
  }
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);

  // Index every managed-DB service into its cluster, keyed by (stack, cluster).
  const clusters = new Map<string, Cluster>();
  const clusterOf = (s: SwarmServiceInfo, cluster: string): Cluster => {
    const stack = s.labels[STACK_LABEL] ?? '';
    const key = `${stack} ${cluster}`;
    const c =
      clusters.get(key) ??
      ({
        stack,
        cluster,
        base: `${stack}_${cluster}`,
        extraPrimaries: new Map(),
        regionReplicas: new Map(),
      } as Cluster);
    clusters.set(key, c);
    return c;
  };
  for (const s of services) {
    const cluster = s.labels[DB_CLUSTER_LABEL];
    if (!cluster) continue;
    // wal-shipper sidecars carry the cluster label but are not Postgres members.
    if (s.labels[DB_WAL_SHIPPER_LABEL] === 'true') {
      clusterOf(s, cluster).shipper = s;
      continue;
    }
    if (s.labels[DB_ENGINE_LABEL] !== 'postgres') continue;
    const c = clusterOf(s, cluster);
    const role = s.labels[DB_ROLE_LABEL];
    const region = s.labels[DB_REGION_LABEL];
    const member = Number.parseInt(s.labels[DB_MEMBER_LABEL] ?? '', 10);
    if (role === 'dcs') {
      c.dcs = s;
    } else if (role === 'primary') {
      if (Number.isFinite(member) && member >= 2) c.extraPrimaries.set(member, s);
      else c.primary = s;
    } else if (role === 'replica') {
      if (region) c.regionReplicas.set(region, s);
      else c.replica = s;
    }
  }

  // Alert/incident/audit contract (system principal), loaded lazily. Failures
  // leave it null and the tick still converges the base topology without it.
  let contract: Contract | null = null;
  const seams = await loadSeams();
  if (seams) {
    try {
      contract = {
        seams,
        ctx: seams.systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId),
      };
    } catch {
      contract = null;
    }
  }

  // Dispatch helpers (best-effort; a failed tick simply retries next interval).
  const deploy = (spec: ServiceSpec) =>
    hub.dispatch(node, 'service.deploy', { spec, pullPolicy: 'always' }).catch(() => undefined);
  const scale = (service: string, replicas: number) =>
    hub.dispatch(node, 'service.scale', { service, replicas }).catch(() => undefined);
  const remove = (service: string) =>
    hub.dispatch(node, 'service.remove', { service }).catch(() => undefined);
  const setLabels = (service: string, add: Record<string, string>) =>
    hub.dispatch(node, 'service.updateLabels', { service, add, removeKeys: [] }).catch(() => undefined);
  const ensureNet = (c: Cluster) =>
    hub
      .dispatch(node, 'network.ensure', {
        name: clusterNet(c),
        driver: 'overlay',
        attachable: true,
        labels: { [MANAGED_LABEL]: 'true', [DB_CLUSTER_LABEL]: c.cluster },
      })
      .catch(() => undefined);

  const nodes = hub.nodeInventory(orgId);
  const multiNode = nodes.length > 1;

  for (const c of clusters.values()) {
    const primary = c.primary;
    const topology = topologyOf(primary?.labels ?? c.replica?.labels);

    // An orphaned wal-shipper (its Postgres members are gone) gets removed.
    if (!primary && !c.replica && c.extraPrimaries.size === 0 && c.regionReplicas.size === 0) {
      if (c.shipper) await remove(c.shipper.name);
      continue;
    }

    // (0) Storage layout — legacy detection (warn, never redeploy), adoption of
    //     mounted-but-undeclared primaries, replica volume/anti-affinity.
    const warnKey = `${orgId}/${c.stack}/${c.cluster}`;
    const task = primary ? execTarget(orgId, primary) : undefined;
    const plan = planClusterStorage({
      base: c.base,
      primary,
      replica: c.replica,
      primaryTaskSwarmNode: task ? hub.swarmNodeIdFor(task.nodeId) : undefined,
      multiNode,
    });
    const primaryPersistent = plan.storage?.state === 'persistent';
    if (plan.actions.some((a) => a.kind === 'warnLegacy')) {
      if (!legacyWarned.has(warnKey) && contract) {
        legacyWarned.add(warnKey);
        const { seams, ctx } = contract;
        await seams.fireEvent(ctx, {
          signal: 'db-storage',
          severity: 'warning',
          resource: `db:${c.stack}/${c.cluster}`,
          message: `${c.cluster}: data is not on a persistent volume — any restart, update or reschedule starts an EMPTY database. Back up, then click Migrate storage.`,
        }).catch(() => undefined);
      }
    } else if (legacyWarned.delete(warnKey) && contract) {
      await contract.seams.fireEvent(contract.ctx, {
        signal: 'db-storage',
        severity: 'info',
        resource: `db:${c.stack}/${c.cluster}`,
        message: `${c.cluster}: data is on a persistent volume`,
        status: 'resolved',
      }).catch(() => undefined);
    }
    for (const action of plan.actions) {
      if (action.kind === 'adopt' && primary) {
        await hub
          .dispatch(node, 'service.updateLabels', {
            service: primary.name,
            add: action.add,
            removeKeys: action.removeKeys,
          })
          .catch(() => undefined);
        if (action.redeploy) {
          const adopted = { ...primary, labels: { ...primary.labels, ...action.add } };
          await deploy(stripPitrSpec(adopted, c));
        }
      } else if (action.kind === 'convergeReplica' && c.replica) {
        await deploy(replicaStorageSpec(c.replica, action.labels, clusterNet(c)));
      }
    }

    const declaredRaw = Number.parseInt(
      primary?.labels[DB_REPLICAS_LABEL] ?? c.replica?.labels[DB_REPLICAS_LABEL] ?? '0',
      10,
    );
    const declared = Number.isNaN(declaredRaw) || declaredRaw < 0 ? 0 : declaredRaw;

    // (1) Base read-replica count. geo carries reads on region siblings, and
    //     single has no replicas — both park the base replica at 0.
    if (c.replica) {
      const target = topology === 'single' || topology === 'geo' ? 0 : declared;
      if ((c.replica.desiredReplicas ?? 0) !== target) await scale(c.replica.name, target);
    }

    // (2) failover — etcd consensus member + leader observation.
    if (topology === 'failover') {
      if (!c.dcs) {
        await ensureNet(c);
        await deploy(dcsSpec(c));
      }
      if (primary) {
        const healthy = (primary.runningReplicas ?? 0) > 0;
        const want = healthy ? primary.name : (primary.labels[DB_LEADER_LABEL] ?? '');
        if (want && primary.labels[DB_LEADER_LABEL] !== want) {
          await setLabels(primary.name, { [DB_LEADER_LABEL]: want });
        }
      }
    } else if (c.dcs) {
      // Topology moved away from failover → tear the consensus member down.
      await remove(c.dcs.name);
    }

    // (3) geo — write-region primary + per-region read replicas.
    if (topology === 'geo') {
      await ensureNet(c);
      const writeRegion = primary?.labels[DB_WRITE_REGION_LABEL];
      if (primary && writeRegion && primary.labels[DB_PLACED_REGION_LABEL] !== writeRegion) {
        // The primary's data volume is node-local: it can only be (re-)placed
        // when its pinned node already sits in the write region. Moving the data
        // across nodes is a backup→restore, never an implicit redeploy.
        const fit = primaryPersistent
          ? pinnedRegionFit(primary.labels[DB_PIN_NODE_LABEL], writeRegion, nodes, REGION_NODE_LABEL)
          : 'unpinned';
        if (fit === 'ok') {
          await deploy(placePrimarySpec(primary, writeRegion, clusterNet(c)));
        } else if (fit === 'mismatch' && contract && !regionMismatchWarned.has(`${warnKey}/${writeRegion}`)) {
          regionMismatchWarned.add(`${warnKey}/${writeRegion}`);
          await contract.seams.fireEvent(contract.ctx, {
            signal: 'db-storage',
            severity: 'warning',
            resource: `db:${c.stack}/${c.cluster}`,
            message: `${c.cluster}: write region "${writeRegion}" requested, but the primary's data lives on a node outside it — move it with a backup + restore into a cluster provisioned in that region`,
          }).catch(() => undefined);
        }
      }
      const wanted = primary ? parseRegionReplicas(primary.labels) : new Map<string, number>();
      // Create missing / scale drifted region siblings.
      for (const [region, n] of wanted) {
        const sib = c.regionReplicas.get(region);
        if (n <= 0) {
          if (sib) await remove(sib.name);
          continue;
        }
        if (!sib) {
          if (primary) await deploy(regionReplicaSpec(c, primary, region, n, multiNode));
        } else if ((sib.desiredReplicas ?? 0) !== n) {
          await scale(sib.name, n);
        }
      }
      // Remove region siblings no longer declared.
      for (const [region, sib] of c.regionReplicas) {
        if (!wanted.has(region) || (wanted.get(region) ?? 0) <= 0) await remove(sib.name);
      }
    } else {
      // Not geo → remove any region siblings left over from a prior geo topology.
      for (const sib of c.regionReplicas.values()) await remove(sib.name);
    }

    // (4) active-active — N writable primaries.
    if (topology === 'active-active') {
      await ensureNet(c);
      const wantPrimaries = Math.max(
        2,
        Number.parseInt(primary?.labels[DB_PRIMARIES_LABEL] ?? '2', 10) || 2,
      );
      if (primary) {
        for (let i = 2; i <= wantPrimaries; i++) {
          if (!c.extraPrimaries.has(i)) {
            const pin = choosePinNode({
              nodes,
              pinnedCounts: pinnedPrimaryCounts(hub.liveInventory(orgId).services),
              fallback: hub.swarmNodeIdFor(node),
            });
            await deploy(extraPrimarySpec(c, primary, i, pin));
          }
        }
      }
      for (const [i, ex] of c.extraPrimaries) {
        if (i > wantPrimaries) await remove(ex.name);
      }
      // CONFLICT CAVEAT (documented): active-active = N writable primaries wired
      // for bidirectional logical replication. swarmy materialises the members;
      // the pub/sub wiring and conflict resolution are engine concerns.
    } else {
      for (const ex of c.extraPrimaries.values()) await remove(ex.name);
    }

    // Stamp the leader on a single-writer-with-replicas cluster too, so the canvas
    // always has a writer to point at (the primary is the leader by definition).
    if (
      topology !== 'failover' &&
      topology !== 'active-active' &&
      primary &&
      (primary.runningReplicas ?? 0) > 0 &&
      primary.labels[DB_LEADER_LABEL] !== primary.name
    ) {
      await setLabels(primary.name, { [DB_LEADER_LABEL]: primary.name });
    }

    // (5) A2 — PITR / WAL archiving convergence (needs the audit/alert trail).
    if (contract) await ensurePitr(contract, orgId, node, c).catch(() => undefined);

    // (6) A2 — replication-lag telemetry (`swarmy.db.lag.<member>` stamps).
    const measured = await measureClusterLag(orgId, node, c).catch(
      (): ClusterLag => ({ members: {}, primaryLsn: null }),
    );

    // (7) A2 — grace-windowed automatic failover promotion.
    if (contract) {
      await maybePromote(contract, orgId, node, c, topology, measured).catch(() => undefined);
    }
  }
}

let lastBackupSweep = 0;

export function startManagedDbReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
    // A1's cron'd DB backups: sweep once per minute, independent of org count.
    const now = Date.now();
    if (minuteDue(lastBackupSweep || null, now)) {
      lastBackupSweep = now;
      void runDueBackupsSweep(new Date(now));
    }
  }, TICK_MS);
  return () => clearInterval(timer);
}
