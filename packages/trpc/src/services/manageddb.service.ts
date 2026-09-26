import { randomBytes } from 'node:crypto';
import {
  MANAGED_PG_ROOT,
  PG_ENV,
  PG_ONESHOT_PASSFILE,
  PG_ONESHOT_PASSFILE_PATH,
  pgPassfileLine,
  DB_PASSWORD_SECRET_LABEL,
  DB_SECRET_KIND_LABEL,
  DB_SECRET_OF_LABEL,
  applyPgBoot,
  applyPgCredential,
  dbPasswordPath,
  dbSecretFamily,
  dbSecretName,
  parseDbSecretName,
  pgNeedsCredentialMigration,
  dbConsumerHasPlaintextUrl,
  secretEnvFileNames,
  type DbSecretKind,
  pgBootRole,
  pgPrimaryEnv,
  pgReplicaEnv,
  DB_DATA_VOLUME_LABEL,
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  encodeFailoverConfirmation,
  parsePendingFailover,
  type PendingFailover,
  BASEBACKUP_OK_MARKER,
  applyPgMember,
  buildInventory,
  choosePinNode,
  DB_PIN_NODE_LABEL,
  dbStorageLabels,
  failoverReadiness,
  dbStorageState,
  pinnedPrimaryCounts,
  primaryDataVolumeName,
  replicaDataVolumeName,
  storageBasebackupScript,
  STACK_LABEL,
  type DbClusterMemberView,
  type DbStorageState,
  type DbWalShipperView,
  type InvService,
  type InvServiceStatus,
} from '@swarmy/core';
import {
  DEFAULT_MANAGED_PG_IMAGE,
  MANAGED_PG_IMAGE_REPO,
  managedPgTag,
  type ContainerInfo,
  type RunOncePayload,
  type RunOnceResult,
  type ServiceSpec,
  type SwarmServiceInfo,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { placeOnDefaultDisk } from './disks.service';
import { AUTO_BACKUP_RETENTION_DAYS } from './autoBackup';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';
import { patchLiveService } from './service-patch';

/**
 * Managed DB topology (epic #8 — "the magic").
 *
 * An operator declares a managed Postgres cluster for a stack ("1 primary + N
 * read replicas") and swarmy PROVISIONS it on the swarm and injects the
 * connection env — no manual wiring. Everything is **Docker-truth**: the
 * topology lives entirely in service labels (`swarmy.db.*`), there is no new
 * Prisma model, and the exact same stack would still run under a plain
 * `docker stack deploy` with these labels as inert metadata.
 *
 * Engine: the official Postgres image contract (pinned via
 * `DEFAULT_MANAGED_PG_IMAGE`, currently `pgvector/pgvector:pg17` = official
 * `postgres:17` + pgvector) under swarmy's own boot layer (@swarmy/core
 * manageddb-pg), which does primary/replica streaming replication from env
 * (`SWARMY_PG_ROLE=primary|replica`: replication role + pg_hba on the writer,
 * `pg_basebackup` + `standby.signal` on replicas). We deploy:
 *   - <stack>_<cluster>-primary  (role=primary, 1 replica)
 *   - <stack>_<cluster>-replica  (role=replica, N replicas, swarm DNS round-robin)
 * both attached to a per-cluster overlay network so the replica resolves the
 * primary by service name, both stamped with the `swarmy.db.*` label scheme.
 *
 * Endpoints (no proxy needed for the first slice — swarm DNS does the work):
 *   - rwHost = <primary service name>  (single writer)
 *   - roHost = <replica service name>  (DNS round-robins across replica tasks)
 *
 * Deferred (intentionally future, see plans/managed-db-topology.md):
 *   - automatic failover / replica→primary promotion (needs a DCS + a promote
 *     command); we provision + scale + inject + read health now.
 *   - dedicated -rw / -ro proxy services (Pgpool/HAProxy) — swarm DNS RR is the
 *     stand-in until a connection pooler is warranted.
 *   - the per-cluster overlay network must exist before deploy. There is no
 *     network-create agent command yet, so provisioning stamps the network into
 *     the spec and the operator (or a future `network.ensure` command) must run
 *     `docker network create -d overlay --attachable <stack>_<cluster>-net`.
 *     This mirrors the secret tradeoff below.
 */

// ── Label scheme (Docker-truth). Kept in sync with manageddb-reconcile.ts, ──
// which cannot subpath-import an internal @swarmy/trpc module (same constraint
// the region/geodns workers document).
export const DB_ENGINE_LABEL = 'swarmy.db.engine';
export const DB_ROLE_LABEL = 'swarmy.db.role';
export const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
/** Declared replica count for the cluster (the reconcile worker converges to this). */
export const DB_REPLICAS_LABEL = 'swarmy.db.replicas';
export const MANAGED_LABEL = 'swarmy.managed';
/** DB-role services must stay warm — the idle sleeper must never scale them to 0. */
export const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
/** On an APP service: which cluster it is wired to + the env var name used. */
export const DB_INJECT_LABEL = 'swarmy.db.inject';
export const DB_INJECT_VAR_LABEL = 'swarmy.db.inject.var';

// ── HA topology (this slice). The topology is a single changeable label on the
// cluster anchor; the manageddb-reconcile worker CONVERGES the live member set to
// match it in-situ. Keep these in sync with manageddb-reconcile.ts (a worker
// cannot subpath-import an internal @swarmy/trpc module). ──

/** The selected HA shape for a cluster (anchor label). Missing ⇒ primary-replica. */
export const DB_TOPOLOGY_LABEL = 'swarmy.db.topology';
/** geo: node-label region the single writer is pinned to (`swarmy.region==<x>`). */
export const DB_WRITE_REGION_LABEL = 'swarmy.db.writeRegion';
/** geo: region the primary was last DEPLOYED into — reconcile re-places when it drifts. */
export const DB_PLACED_REGION_LABEL = 'swarmy.db.placedRegion';
/** geo region-replica sibling: which region it is pinned to (mirrors region-reconcile). */
export const DB_REGION_LABEL = 'swarmy.db.region';
/** active-active: desired number of writable primaries (>=2). */
export const DB_PRIMARIES_LABEL = 'swarmy.db.primaries';
/** active-active: 1-based member index on extra primaries (base primary is unlabelled/1). */
export const DB_MEMBER_LABEL = 'swarmy.db.member';
/** failover: status label the reconcile stamps with the observed leader service name. */
export const DB_LEADER_LABEL = 'swarmy.db.leader';
/**
 * Replication-lag telemetry (slice A2): `swarmy.db.lag.<memberService>=<seconds>`
 * stamped on the cluster PRIMARY by the reconcile each tick (one label per
 * member so a single anchor read yields the whole cluster's lag picture).
 */
export const DB_LAG_LABEL_PREFIX = 'swarmy.db.lag.';
/** PITR (A2): version marker the reconcile stamps once WAL archiving is applied
 *  (archive volume + extended conf + wal-shipper). Steady state = no redeploys. */
export const DB_PITR_APPLIED_LABEL = 'swarmy.db.pitr.applied';
/** Marks the per-cluster wal-shipper sidecar service (not a Postgres member). */
export const DB_WAL_SHIPPER_LABEL = 'swarmy.db.walShipper';
/** Mirror of dbBackup.service `DB_BACKUP_PITR_LABEL` — importing it here would
 *  create a module cycle (dbBackup.service imports this file), so the string is
 *  kept in sync instead. */
const DB_BACKUP_PITR_FLAG_LABEL = 'swarmy.db.backup.pitr';
/** Node label naming a node's region — shared with region/geodns (placement constraints). */
export const REGION_NODE_LABEL = 'swarmy.region';
/** `swarmy.db.region.<region>.replicas=<n>` — per-region read-replica declarations (geo). */
const DB_REGION_REPLICAS_PREFIX = 'swarmy.db.region.';
const DB_REGION_REPLICAS_SUFFIX = '.replicas';
const DB_REGION_REPLICAS_RE = /^swarmy\.db\.region\.(.+)\.replicas$/;

/** Selectable HA topologies. Order = least→most advanced. */
export const DB_TOPOLOGIES = [
  'single', // one writer, no replicas (replica service parked at 0)
  'primary-replica', // current default: 1 writer + N async read replicas
  'failover', // primary-replica + controller-decided promotion (caught-up rule)
  'geo', // write-region primary + per-region read replicas
  'active-active', // 2+ writable primaries (bidirectional logical replication)
] as const;
export type DbTopology = (typeof DB_TOPOLOGIES)[number];
export const DEFAULT_TOPOLOGY: DbTopology = 'primary-replica';

const PG_PORT = 5432;
const REPLICATION_USER = 'repl';
const DEFAULT_DATABASE = 'app';
const DISPATCH_TIMEOUT_MS = 60_000;

export type DbEngine = 'postgres';

/** Docker label key carrying the per-region read-replica count for `region`. */
export function regionReplicasLabelKey(region: string): string {
  return `${DB_REGION_REPLICAS_PREFIX}${region}${DB_REGION_REPLICAS_SUFFIX}`;
}

/** Parse `swarmy.db.region.<region>.replicas` labels → { region: count }. */
function parseRegionReplicas(labels: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(labels)) {
    const m = DB_REGION_REPLICAS_RE.exec(key);
    if (!m) continue;
    const region = m[1];
    const n = Number.parseInt(value, 10);
    if (!region || Number.isNaN(n) || n < 0) continue;
    out[region] = n;
  }
  return out;
}

/** Read the cluster's topology off a member's labels (default primary-replica). */
function topologyOf(labels: Record<string, string> | undefined): DbTopology {
  const v = labels?.[DB_TOPOLOGY_LABEL];
  return (DB_TOPOLOGIES as readonly string[]).includes(v ?? '')
    ? (v as DbTopology)
    : DEFAULT_TOPOLOGY;
}

/** `<stack>_<cluster>-primary` — the single writer; also the rw DNS host. */
export function primaryServiceName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-primary`;
}
/** `<stack>_<cluster>-replica` — N read replicas; swarm DNS RR = the ro host. */
export function replicaServiceName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-replica`;
}
/** Per-cluster attachable overlay network joining primary + replicas + apps. */
export function clusterNetworkName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-net`;
}
/** `<stack>_<cluster>-wal-shipper` — the PITR WAL-push sidecar service (A2). */
export function walShipperServiceName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-wal-shipper`;
}
/** Named volume the primary archives WAL into (shared with the wal-shipper). */
export function walArchiveVolumeName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-wal-archive`;
}
/** Docker config carrying the archive_mode/archive_command extended conf. */
export function pitrConfigName(stack: string, cluster: string): string {
  return `${stack}_${cluster}-pitr-conf`;
}

/** Label key carrying `member`'s replication lag on the cluster primary. */
export function lagLabelKey(member: string): string {
  return `${DB_LAG_LABEL_PREFIX}${member}`;
}

/**
 * Parse the primary's `swarmy.db.lag.<member>` labels → { member: seconds }.
 * Malformed/negative values are dropped (a foreign label never breaks the view).
 */
export function parseLagLabels(labels: Record<string, string> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!key.startsWith(DB_LAG_LABEL_PREFIX)) continue;
    const member = key.slice(DB_LAG_LABEL_PREFIX.length);
    const n = Number.parseFloat(value);
    if (!member || !Number.isFinite(n) || n < 0) continue;
    out[member] = n;
  }
  return out;
}

/** URL-safe secret (no chars that need percent-encoding in a postgres:// URL). */
function generatePassword(): string {
  return randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
}

/** Read a live service's `KEY=VALUE` env entries into a record. */
function envRecord(s: InvService): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of s.env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/** Live services for a stack (grouped by the Docker stack-namespace label). */
function liveStackServices(ctx: OrgContext, stack: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stack);
}

function findCluster(
  ctx: OrgContext,
  stack: string,
  cluster: string,
): { primary?: InvService; replica?: InvService; members: InvService[] } {
  const members = liveStackServices(ctx, stack).filter(
    (s) => s.labels[DB_CLUSTER_LABEL] === cluster,
  );
  return {
    // The base primary/replica are the unregioned anchors; geo region-replica
    // siblings also carry role=replica, so prefer the unregioned member.
    primary: members.find(
      (s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL],
    ),
    replica:
      members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica' && !s.labels[DB_REGION_LABEL]) ??
      members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica'),
    members,
  };
}

/** The raw live swarm service (carries `mounts`, which InvService does not). */
function liveSwarmService(ctx: OrgContext, name: string): SwarmServiceInfo | undefined {
  return ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === name);
}

/** A running task container of `service` + the (controller) node hosting it. */
export function runningTaskOf(
  ctx: OrgContext,
  service: SwarmServiceInfo,
): { nodeId: string; container: ContainerInfo } | undefined {
  const orgContainerIds = new Set(ctx.hub.liveInventory(ctx.activeOrgId).containers.map((c) => c.id));
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    const container = ctx.hub.latestContainers(nodeId).find((c) => {
      if (!orgContainerIds.has(c.id)) return false;
      const sid = c.serviceId ?? c.labels?.['com.docker.swarm.service.id'];
      return sid === service.id && c.state === 'running';
    });
    if (container) return { nodeId, container };
  }
  return undefined;
}

/**
 * Default standby (plans/epic-volume-mobility.md §5.1, owner-approved): a new
 * managed Postgres gets ONE streaming standby once the swarm has this many
 * ready servers. It is anti-affine to the primary (`node.id!=<primary>`), so
 * it is a copy on a different server. Costs about
 * {@link DEFAULT_STANDBY_RAM_MB} MB of RAM.
 */
export const DEFAULT_STANDBY_MIN_SERVERS = 2;
/** Rough resident size of one idle standby (shown in the create form). */
export const DEFAULT_STANDBY_RAM_MB = 100;

/** Pure: replicas for a new cluster when the caller did not choose. */
export function defaultStandbyReplicas(readyServers: number): number {
  return readyServers >= DEFAULT_STANDBY_MIN_SERVERS ? 1 : 0;
}

/** Servers a standby could land on: ready + active (not paused/drained). */
export function readyServerCount(nodes: ReadonlyArray<{ status?: string; availability?: string }>): number {
  return nodes.filter((n) => n.status === 'ready' && n.availability === 'active').length;
}

/** More than one swarm node ⇒ replicas get anti-affinity from the primary's node. */
function isMultiNode(ctx: OrgContext): boolean {
  return ctx.hub.nodeInventory(ctx.activeOrgId).length > 1;
}

/**
 * The swarm node a NEW primary is pinned to: the node with the fewest pinned
 * primaries (ready + active), ties to the manager we dispatch through.
 */
function choosePrimaryPin(ctx: OrgContext, managerNodeId: string): string | undefined {
  return choosePinNode({
    nodes: ctx.hub.nodeInventory(ctx.activeOrgId),
    pinnedCounts: pinnedPrimaryCounts(ctx.hub.liveInventory(ctx.activeOrgId).services),
    fallback: ctx.hub.swarmNodeIdFor(managerNodeId),
  });
}

/** Common labels stamped on every DB-role service (primary + replica). */
function dbLabels(
  stack: string,
  cluster: string,
  role: 'primary' | 'replica',
  replicas: number,
  topology: DbTopology = DEFAULT_TOPOLOGY,
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: stack,
    [DB_ENGINE_LABEL]: 'postgres',
    [DB_CLUSTER_LABEL]: cluster,
    [DB_ROLE_LABEL]: role,
    [DB_REPLICAS_LABEL]: String(replicas),
    [DB_TOPOLOGY_LABEL]: topology,
    // DBs must stay warm: belt-and-suspenders marker so the idle sleeper skips
    // these (it already skips anything without `scaleToZero.enabled=true`).
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
  };
}

export interface ProvisionDbInput {
  stack: string;
  /** Cluster name, e.g. "main". Service names derive from <stack>_<name>-*. */
  name: string;
  engine?: DbEngine;
  /**
   * Number of read replicas (the replica service's desired replica count).
   * Omitted ⇒ the default standby: 1 copy on a different server once the swarm
   * has {@link DEFAULT_STANDBY_MIN_SERVERS}+ ready servers, else 0 (see
   * {@link defaultStandbyReplicas}). A re-provision keeps the declared count.
   * Pass 0 to opt out of the standby.
   */
  replicas?: number;
  /** Optional caller-supplied superuser password; generated when omitted. */
  password?: string;
  /** Database created on the primary (default "app"). */
  database?: string;
  /**
   * Tag of the managed Postgres image repo (`MANAGED_PG_IMAGE_REPO`, default
   * tag "pg17"; a bare major like "16" means "pg16"). Ignored when `image` is set.
   */
  imageTag?: string;
  /**
   * Full image ref override (e.g. a private mirror, or plain `postgres:17`
   * without pgvector). Must honour the official postgres image contract
   * (docker-entrypoint.sh, POSTGRES_*, PGDATA, gosu). Wins over `imageTag`.
   */
  image?: string;
  /**
   * Default-on backups (default true): a new cluster is born with a nightly
   * `pg_dump` schedule (keep 7, staggered 02:00–04:59 UTC) when a destination
   * exists. False for throwaway clusters (restore drills).
   */
  autoBackup?: boolean;
}

/** A Bitnami (or frozen bitnamilegacy) image ref — the pre-B5 engine contract. */
export function isBitnamiImage(image: string): boolean {
  return /^(docker\.io\/)?bitnami(legacy)?\//.test(image.trim());
}

/**
 * Resolve the engine image for a (re-)provision: explicit `image` → explicit
 * `imageTag` → the live primary's image (so re-provisioning keeps a per-cluster
 * override) → the pinned default. A live Bitnami image (the pre-B5 engine, a
 * different env/path contract the boot layer cannot drive) is never carried
 * forward — the default replaces it.
 */
export function resolveManagedPgImage(
  input: Pick<ProvisionDbInput, 'image' | 'imageTag'>,
  existingImage?: string,
): string {
  const explicit = input.image?.trim();
  if (explicit) return explicit;
  const tag = input.imageTag?.trim();
  if (tag) return `${MANAGED_PG_IMAGE_REPO}:${managedPgTag(tag)}`;
  // Inventory images can carry a pinned digest (`repo:tag@sha256:…`); drop it so
  // a rewritten repo is not pinned to a digest from the old namespace.
  const live = existingImage?.split('@')[0]?.trim();
  if (live && !isBitnamiImage(live)) return live;
  return DEFAULT_MANAGED_PG_IMAGE;
}

export interface ProvisionDbResult {
  cluster: string;
  engine: DbEngine;
  primaryService: string;
  replicaService: string;
  network: string;
  rwHost: string;
  roHost: string;
  replicas: number;
  /** True when `replicas` was not given and the server-count default chose it. */
  replicasDefaulted: boolean;
  /**
   * The env var naming the password FILE on the members (`POSTGRES_PASSWORD_FILE`).
   * The password itself is NEVER in this result: a client sees it only via
   * the audited, `secrets.read`-gated `db.revealPassword` ({@link revealDbPassword}).
   */
  passwordEnv: string;
  /** The Docker secret holding it (a name, never a value). */
  passwordSecret: string;
}

/**
 * {@link provisionDbWithPassword}'s result: the public result plus the
 * superuser password. SERVER-SIDE ONLY (blueprint token wiring) — never return
 * it from a router or REST route.
 */
export interface ProvisionDbInternalResult extends ProvisionDbResult {
  password: string;
}

function omit(labels: Record<string, string>, keys: string[]): Record<string, string> {
  const out = { ...labels };
  for (const k of keys) delete out[k];
  return out;
}

export interface ManagedPgSpecInput {
  stack: string;
  cluster: string;
  image: string;
  /** The cluster's password Docker secret (`<family>__v<n>`) — the spec carries only its file path. */
  passwordSecret: string;
  database: string;
  replicas: number;
  /** Named volume holding the primary's data root (`/var/lib/postgresql/data`). */
  dataVolume: string;
  /** Per-node replica volume name. */
  replicaVolume: string;
  /** Docker swarm node id the primary is pinned to. */
  pinNode: string;
  /** >1 swarm node ⇒ replicas avoid the primary's node. */
  multiNode: boolean;
  /** Live primary labels to carry forward (declared by later mutations). */
  carryLabels?: Record<string, string>;
}

/**
 * The primary + replica ServiceSpecs of a managed Postgres cluster. Pure —
 * exported for the golden test. The storage layout (mount + pin + anti-affinity
 * + one-task-per-node) is declared on labels and derived by `applyPgMember`,
 * the same function every reconcile rebuild uses, so they can never disagree.
 */
export function managedPgSpecs(input: ManagedPgSpecInput): {
  primarySpec: ServiceSpec;
  replicaSpec: ServiceSpec;
} {
  const { stack, cluster } = input;
  const primary = primaryServiceName(stack, cluster);
  const network = clusterNetworkName(stack, cluster);
  const credential: Record<string, string> = { [DB_PASSWORD_SECRET_LABEL]: input.passwordSecret };
  const primaryLabels = {
    ...(input.carryLabels ?? {}),
    ...dbLabels(stack, cluster, 'primary', input.replicas),
    ...dbStorageLabels({ dataVolume: input.dataVolume, pinNode: input.pinNode }),
    ...credential,
  };
  // A re-provision keeps a selected topology rather than resetting it.
  if (input.carryLabels?.[DB_TOPOLOGY_LABEL]) {
    primaryLabels[DB_TOPOLOGY_LABEL] = input.carryLabels[DB_TOPOLOGY_LABEL];
  }
  const primarySpec: ServiceSpec = applyPgMember<ServiceSpec>(
    {
      name: primary,
      image: input.image,
      mode: { replicated: { replicas: 1 } },
      labels: primaryLabels,
      env: pgPrimaryEnv({ database: input.database, replicationUser: REPLICATION_USER }),
      networks: [network],
    },
    primaryLabels,
  );

  const replicaLabels = {
    ...dbLabels(stack, cluster, 'replica', input.replicas, topologyOf(primaryLabels)),
    ...dbStorageLabels({
      dataVolume: input.replicaVolume,
      ...(input.multiNode ? { avoidNode: input.pinNode } : {}),
    }),
    ...credential,
  };
  const replicaSpec: ServiceSpec = applyPgMember<ServiceSpec>(
    {
      name: replicaServiceName(stack, cluster),
      image: input.image,
      mode: { replicated: { replicas: input.replicas } },
      labels: replicaLabels,
      env: pgReplicaEnv({ replicationUser: REPLICATION_USER, primaryHost: primary, primaryPort: PG_PORT }),
      networks: [network],
    },
    replicaLabels,
  );
  return { primarySpec, replicaSpec };
}

/**
 * Provision a managed Postgres cluster on the swarm.
 *
 * Credentials: the password is a Docker SECRET (`<stack>_<cluster>-pg-password__v<n>`),
 * mounted as a file (`POSTGRES_PASSWORD_FILE`, which the official image
 * honours) and named by the members' `swarmy.db.passwordSecret` label. No
 * spec carries it as env — `docker service inspect` shows no password.
 */
export async function provisionDb(ctx: OrgContext, input: ProvisionDbInput): Promise<ProvisionDbResult> {
  return (await provisionDbCore(ctx, input)).result;
}

/**
 * {@link provisionDb} that also hands the superuser password back to a
 * SERVER-SIDE caller (blueprints wire it into generated tokens). Never expose
 * this result to a client.
 */
export async function provisionDbWithPassword(
  ctx: OrgContext,
  input: ProvisionDbInput,
): Promise<ProvisionDbInternalResult> {
  const { result, password } = await provisionDbCore(ctx, input);
  return { ...result, password: password ?? (await readDbPassword(ctx, input.stack.trim(), result.cluster)) };
}

async function provisionDbCore(
  ctx: OrgContext,
  input: ProvisionDbInput,
): Promise<{ result: ProvisionDbResult; password?: string }> {
  if ((input.engine ?? 'postgres') !== 'postgres') {
    throw commandRejected(`unsupported engine "${input.engine}" (only postgres for now)`);
  }
  const stack = input.stack.trim();
  const cluster = input.name.trim();
  if (!stack || !cluster) throw commandRejected('stack and name are required');
  const database = (input.database ?? DEFAULT_DATABASE).trim() || DEFAULT_DATABASE;
  const node = await resolveManagerNode(ctx);

  const primary = primaryServiceName(stack, cluster);
  const replica = replicaServiceName(stack, cluster);
  const network = clusterNetworkName(stack, cluster);

  // One password reused for the superuser + replication account keeps the slice
  // simple; both services must agree on the replication credential.
  const existing = findCluster(ctx, stack, cluster).primary;
  // Replicas: explicit → the live declaration (re-provision keeps it) → the
  // default standby when the swarm has 2+ ready servers.
  const declaredReplicas = existing ? Number.parseInt(existing.labels[DB_REPLICAS_LABEL] ?? '', 10) : Number.NaN;
  const replicasDefaulted = input.replicas == null && !Number.isFinite(declaredReplicas);
  const replicas = Math.max(
    0,
    Math.floor(
      input.replicas ??
        (Number.isFinite(declaredReplicas)
          ? declaredReplicas
          : defaultStandbyReplicas(readyServerCount(ctx.hub.nodeInventory(ctx.activeOrgId)))),
    ),
  );
  const image = resolveManagedPgImage(input, existing?.image);
  // The credential: an existing cluster keeps its secret (an initialised
  // database ignores a new POSTGRES_PASSWORD anyway); a legacy one (plain env)
  // moves its value into a secret; a new one gets the given or a fresh password.
  const existingSecret = existing?.labels[DB_PASSWORD_SECRET_LABEL];
  const legacyPassword = existing && !existingSecret ? envRecord(existing)[PG_ENV.password] : undefined;
  const password = existingSecret ? undefined : legacyPassword || input.password?.trim() || generatePassword();
  const passwordSecret = existingSecret ?? dbSecretName(stack, cluster, 'password', 1);

  // ── Storage: never let a (re-)provision move a live writer onto an empty volume.
  const existingLive = existing ? liveSwarmService(ctx, existing.name) : undefined;
  let dataVolume = primaryDataVolumeName(stack, cluster);
  let pinNode: string | undefined;
  if (existingLive) {
    const storage = dbStorageState(existingLive);
    if (storage.state === 'unmounted') {
      throw commandRejected(
        `cluster "${cluster}" keeps its data on an anonymous volume — re-provisioning would start an EMPTY database. Back up, then run Migrate storage (db.migrateStorage) first.`,
      );
    }
    if (storage.state === 'unknown') {
      throw commandRejected(
        `cannot verify where cluster "${cluster}" keeps its data (the node agent is too old to report mounts) — update the agent before re-provisioning`,
      );
    }
    dataVolume = storage.dataVolume ?? dataVolume;
    pinNode =
      storage.pinnedNode ??
      // Mounted but never pinned (pre-label PITR dataVolume): pin to where it runs now.
      (() => {
        const task = runningTaskOf(ctx, existingLive);
        return task ? ctx.hub.swarmNodeIdFor(task.nodeId) : undefined;
      })();
  }
  pinNode ??= choosePrimaryPin(ctx, node.id);
  if (!pinNode) {
    throw commandRejected(
      'cannot resolve a swarm node to pin the Postgres primary to (no node has reported yet) — retry in a few seconds',
    );
  }
  // A NEW cluster's primary volume lands on the pinned server's added disk,
  // when it has one (plans/epic-volume-mobility.md phase 1). Never for an
  // existing cluster: its data already lives where it is.
  // The pin already prefers a node with a default disk (choosePinNode); a
  // failed pre-create there is an error, not a silent root-disk fallback (QA-076).
  if (!existingLive) await placeOnDefaultDisk(ctx, pinNode, dataVolume, { required: true });
  const existingReplica = findCluster(ctx, stack, cluster).replica;

  // Default-on backups: born with a nightly pg_dump schedule unless the primary
  // already declares one (or the user opted out). Lazy import: autoBackup.service
  // reads this module's label constants. Never fails the provision.
  const autoBackup =
    input.autoBackup === false
      ? { labels: {} as Record<string, string> }
      : await import('./autoBackup.service')
          .then((m) => m.autoDbScheduleLabels(ctx, stack, cluster, existing?.labels))
          .catch(() => ({ labels: {} as Record<string, string> }));
  const carried = existing ? omit(existing.labels, [DB_PITR_APPLIED_LABEL]) : undefined;

  const { primarySpec, replicaSpec } = managedPgSpecs({
    stack,
    cluster,
    image,
    passwordSecret,
    database,
    replicas,
    dataVolume,
    replicaVolume: existingReplica?.labels[DB_DATA_VOLUME_LABEL] ?? replicaDataVolumeName(stack, cluster),
    pinNode,
    multiNode: isMultiNode(ctx),
    // Carry declarations the primary accumulated (backup schedule, topology
    // inputs, …) — minus the PITR marker, whose mounts/conf this base spec does
    // not carry: dropping it makes the reconcile re-apply WAL archiving.
    carryLabels:
      Object.keys(autoBackup.labels).length > 0 ? { ...(carried ?? {}), ...autoBackup.labels } : carried,
  });

  try {
    // Ensure the per-cluster overlay network exists BEFORE deploying onto it —
    // otherwise the service.deploy fails with "network <stack>_<cluster>-net not
    // found" (the reconcile worker also ensures it, but provision must not race
    // that first tick). Idempotent.
    if (password !== undefined) {
      await createDbSecret(ctx, node.id, stack, cluster, 'password', passwordSecret, password);
    }
    await ctx.hub.dispatch(
      node.id,
      'network.ensure',
      {
        name: network,
        driver: 'overlay',
        attachable: true,
        labels: { [MANAGED_LABEL]: 'true', [DB_CLUSTER_LABEL]: cluster },
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec: primarySpec, pullPolicy: 'always' }, { timeoutMs: DISPATCH_TIMEOUT_MS });
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec: replicaSpec, pullPolicy: 'always' }, { timeoutMs: DISPATCH_TIMEOUT_MS });
  } catch (e) {
    throw mapDispatchError(e);
  }
  if ('targetId' in autoBackup && autoBackup.targetId) {
    const { auditAutoSchedule } = await import('./autoBackup.service');
    await auditAutoSchedule(ctx, {
      targetType: 'dbCluster',
      targetId: `${stack}/${cluster}`,
      metadata: {
        kind: 'managed',
        engine: 'pg_dump',
        cron: autoBackup.cron,
        retentionDays: AUTO_BACKUP_RETENTION_DAYS,
        targetId: autoBackup.targetId,
        at: 'provision',
      },
    });
  }

  return {
    result: {
      cluster,
      engine: 'postgres',
      primaryService: primary,
      replicaService: replica,
      network,
      rwHost: primary,
      roHost: replica,
      replicas,
      replicasDefaulted,
      passwordEnv: PG_ENV.passwordFile,
      passwordSecret,
    },
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * Reveal a cluster's superuser password — the ONLY way a client reads it.
 * The router gates this on `secrets.read` (ABAC, audited permit/deny); this
 * writes the `db.password.reveal` business audit row (never the value). The
 * password is read from Docker truth (the primary's env), never from a store.
 */
export async function revealDbPassword(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): Promise<{ cluster: string; password: string }> {
  let password: string;
  try {
    password = await readDbPassword(ctx, input.stack, input.cluster);
  } catch (e) {
    await writeAudit(ctx, {
      action: 'db.password.reveal',
      targetType: 'dbCluster',
      targetId: `${input.stack}/${input.cluster}`,
      metadata: { ok: false },
    });
    throw e;
  }
  await writeAudit(ctx, {
    action: 'db.password.reveal',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { ok: true },
  });
  return { cluster: input.cluster, password };
}

// ── Credentials: the password is a Docker secret, never spec env ─────────────

const SECRET_READ_TIMEOUT_MS = 15_000;

function dbSecretLabels(stack: string, cluster: string, kind: DbSecretKind, version: number): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [DB_CLUSTER_LABEL]: cluster,
    [DB_SECRET_OF_LABEL]: `${stack}/${cluster}`,
    [DB_SECRET_KIND_LABEL]: kind,
    'swarmy.secret.version': String(version),
  };
}

/**
 * Create one managed-DB secret. The value is base64 on the authenticated WS
 * straight into the Docker API — never logged, never persisted. A secret
 * already there under this exact version name is kept (a retried migration).
 */
async function createDbSecret(
  ctx: OrgContext,
  nodeId: string,
  stack: string,
  cluster: string,
  kind: DbSecretKind,
  name: string,
  value: string,
): Promise<void> {
  const version = parseDbSecretName(name)?.version ?? 1;
  try {
    await ctx.hub.dispatch(
      nodeId,
      'secret.create',
      { name, dataB64: Buffer.from(value, 'utf8').toString('base64'), labels: dbSecretLabels(stack, cluster, kind, version) },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    if (/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) return;
    throw mapDispatchError(e);
  }
}

/**
 * Read a cluster's superuser password from Docker truth — SERVER-SIDE ONLY
 * (reveal, backups, URL secrets, storage migration). A secret-backed cluster
 * is read the one way Docker allows: `cat` of the mounted secret file inside
 * a running member task (the same path `services.revealSecretVar` uses); a
 * legacy member's plain env is read as before until it is migrated.
 */
export async function readDbPassword(ctx: OrgContext, stack: string, cluster: string): Promise<string> {
  const { primary, members } = findCluster(ctx, stack, cluster);
  if (!primary) throw notFound('db cluster primary', cluster);
  const secret = primary.labels[DB_PASSWORD_SECRET_LABEL];
  if (!secret) {
    const legacy = envRecord(primary)[PG_ENV.password];
    if (legacy) return legacy;
    throw commandRejected(`cluster "${cluster}" declares no password secret`);
  }
  const path = dbPasswordPath(secret);
  const candidates = [primary, ...members.filter((m) => m.id !== primary.id && m.labels[DB_PASSWORD_SECRET_LABEL] === secret)];
  for (const m of candidates) {
    const target = resolveExecTarget(ctx, m.id, { newest: true });
    if (!target) continue;
    const res = await ctx.hub
      .dispatch<{ exitCode: number; output?: string }>(
        target.nodeId,
        'exec',
        { target: { containerId: target.containerId }, cmd: ['cat', path], tty: false, stream: false },
        { timeoutMs: SECRET_READ_TIMEOUT_MS },
      )
      .catch(() => null);
    if (res && res.exitCode === 0 && res.output) return res.output.replace(/\r?\n$/, '');
  }
  throw commandRejected(`no running member of "${cluster}" to read its password from — start it first`);
}

/** Members in update order: the base primary first, then the other writers, then the rest. */
function membersInOrder(members: InvService[], primary: InvService): InvService[] {
  return [
    primary,
    ...members.filter((m) => m.id !== primary.id && m.labels[DB_ROLE_LABEL] === 'primary'),
    ...members.filter((m) => m.id !== primary.id && m.labels[DB_ROLE_LABEL] !== 'primary'),
  ];
}

/** Put one member onto `secret` in ONE update: label + secret file + boot layer, no plaintext env. */
async function patchMemberCredential(ctx: OrgContext, member: InvService, secret: string): Promise<void> {
  await patchLiveService(ctx, member, {
    setLabels: { [DB_PASSWORD_SECRET_LABEL]: secret },
    // Re-stamp the boot layer too: an old entrypoint only knows the plain env.
    transform: (spec) => applyPgBoot(applyPgCredential(spec, spec.labels)),
  });
}

/** An app wired by `db.inject` still carrying its connection URL (and so the password) as plain env. */
function consumerNeedsMigration(app: InvService, cluster: string): boolean {
  return dbConsumerHasPlaintextUrl(envRecord(app), app.labels, cluster);
}

/**
 * Migrate an existing cluster off plain-env passwords (the reconcile runs
 * this on every tick until nothing is left): create the password secret from
 * the live env value, then put every member on it — secret file + `_FILE`
 * env, plain env removed, boot layer re-stamped — in ONE update per member,
 * the writer first. Apps wired by `db.inject` move their connection URL into
 * a secret delivered as env. Idempotent; audited `db.credentials.migrate`.
 */
export async function migrateDbCredentials(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): Promise<{ cluster: string; secret?: string; members: string[]; consumers: string[] }> {
  const { stack, cluster } = input;
  const { primary, members } = findCluster(ctx, stack, cluster);
  if (!primary) return { cluster, members: [], consumers: [] };
  let secret = primary.labels[DB_PASSWORD_SECRET_LABEL];
  const moved: string[] = [];
  // Never restart a writer whose data is not on a persistent volume: a legacy
  // anonymous-volume primary would come back EMPTY. Migrate storage first.
  const writerLive = liveSwarmService(ctx, primary.name);
  const writerSafe = Boolean(writerLive && dbStorageState(writerLive).state === 'persistent');
  if (writerSafe) {
    const node = await resolveManagerNode(ctx);
    if (!secret) {
      const env = envRecord(primary);
      const password = env[PG_ENV.password];
      const repl = env[PG_ENV.replicationPassword];
      if (password && repl && repl !== password) {
        throw commandRejected(
          `cluster "${cluster}": the replication password differs from the superuser password — it cannot share one secret; rotate it first`,
        );
      }
      if (password) {
        secret = dbSecretName(stack, cluster, 'password', 1);
        await createDbSecret(ctx, node.id, stack, cluster, 'password', secret, password);
      }
    }
    if (secret) {
      for (const m of membersInOrder(members, primary)) {
        if (m.labels[DB_PASSWORD_SECRET_LABEL] === secret && !pgNeedsCredentialMigration(envRecord(m), {})) continue;
        await patchMemberCredential(ctx, m, secret);
        moved.push(m.name);
      }
    }
  }
  // Apps: independent of the members (QA-084b) — an app wired BEFORE the
  // upgrade keeps a plaintext DATABASE_URL* until re-wired, even when the
  // members were migrated on an earlier tick. Every pass re-wires any app
  // still carrying one onto the URL secrets (idempotent: a re-wired app no
  // longer matches).
  const consumers: string[] = [];
  for (const app of liveStackServices(ctx, stack)) {
    if (!consumerNeedsMigration(app, cluster)) continue;
    await injectConnection(ctx, { stack, cluster, appService: app.name, envVar: app.labels[DB_INJECT_VAR_LABEL] || 'DATABASE_URL' });
    consumers.push(app.name);
  }
  if (moved.length || consumers.length) {
    await writeAudit(ctx, {
      action: 'db.credentials.migrate',
      targetType: 'dbCluster',
      targetId: `${stack}/${cluster}`,
      metadata: { secret, members: moved, consumers },
    });
  }
  return { cluster, secret, members: moved, consumers };
}

const ROTATE_POLL_MS = 3_000;
const ROTATE_WAIT_MS = 120_000;

/** In-member SQL (unix socket; the official image trusts local) setting both roles from the NEW secret file. */
export function rotateRolesScript(passwordPath: string, replicationUser: string): string {
  return [
    'set -e',
    `psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v u='${replicationUser.replace(/'/g, '')}' <<'SQL'`,
    `\\set p \`cat ${passwordPath}\``,
    "SELECT format('ALTER ROLE %I PASSWORD %L', 'postgres', :'p') \\gexec",
    "SELECT format('ALTER ROLE %I PASSWORD %L', :'u', :'p') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \\gexec",
    'SQL',
  ].join('\n');
}

/**
 * Rotate a cluster's password: mint `<family>__v<n+1>`, move each WRITER onto
 * it (one redeploy — a brief restart) and set both roles from the new file
 * over the local socket (the value never rides argv or env), then the
 * standbys, then every `db.inject`ed app onto new URL secrets; the old
 * versions are removed once nothing mounts them. Audited `db.password.rotate`.
 */
export async function rotateDbPassword(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
  timing: { pollMs?: number; waitMs?: number } = {},
): Promise<{ cluster: string; secret: string; version: number; redeployed: string[] }> {
  const { stack, cluster } = input;
  await migrateDbCredentials(ctx, input);
  const { primary, members } = findCluster(ctx, stack, cluster);
  if (!primary) throw notFound('db cluster primary', cluster);
  const current = primary.labels[DB_PASSWORD_SECRET_LABEL];
  const parsed = current ? parseDbSecretName(current) : null;
  if (!current || !parsed) throw commandRejected(`cluster "${cluster}" has no password secret to rotate`);
  const version = parsed.version + 1;
  const next = dbSecretName(stack, cluster, 'password', version);
  const password = generatePassword();
  const node = await resolveManagerNode(ctx);
  await createDbSecret(ctx, node.id, stack, cluster, 'password', next, password);

  const redeployed: string[] = [];
  const ordered = membersInOrder(members, primary);
  const writers = ordered.filter((m) => m.labels[DB_ROLE_LABEL] === 'primary' && pgBootRole(envRecord(m)) === 'primary');
  const replUser = envRecord(primary)[PG_ENV.replicationUser] || REPLICATION_USER;
  for (const w of writers) {
    const before = resolveExecTarget(ctx, w.id, { newest: true })?.containerId;
    await patchMemberCredential(ctx, w, next);
    redeployed.push(w.name);
    const deadline = Date.now() + (timing.waitMs ?? ROTATE_WAIT_MS);
    let done = false;
    while (!done && Date.now() < deadline) {
      const t = resolveExecTarget(ctx, w.id, { newest: true });
      if (t && t.containerId !== before) {
        const res = await ctx.hub
          .dispatch<{ exitCode: number; output?: string }>(
            t.nodeId,
            'exec',
            { target: { containerId: t.containerId }, cmd: ['sh', '-c', rotateRolesScript(dbPasswordPath(next), replUser)], tty: false, stream: false },
            { timeoutMs: SECRET_READ_TIMEOUT_MS },
          )
          .catch(() => null);
        if (res && res.exitCode === 0) {
          done = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, timing.pollMs ?? ROTATE_POLL_MS));
    }
    if (!done) {
      throw commandRejected(
        `${w.name} is on the new password secret ${next}, but setting the role passwords did not complete — re-run the rotation once it is running`,
      );
    }
  }
  for (const m of ordered) {
    if (writers.includes(m)) continue;
    await patchMemberCredential(ctx, m, next);
    redeployed.push(m.name);
  }
  for (const app of liveStackServices(ctx, stack)) {
    if (app.labels[DB_INJECT_LABEL] !== cluster) continue;
    await injectConnection(
      ctx,
      { stack, cluster, appService: app.name, envVar: app.labels[DB_INJECT_VAR_LABEL] || 'DATABASE_URL' },
      { password, passwordSecret: next },
    );
    redeployed.push(app.name);
  }
  // Old versions go once nothing mounts them (Docker refuses while in use).
  for (let v = 1; v < version; v++) {
    for (const kind of ['password', 'url', 'ro-url'] as const) {
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: dbSecretName(stack, cluster, kind, v) }).catch(() => undefined);
    }
  }
  await writeAudit(ctx, {
    action: 'db.password.rotate',
    targetType: 'dbCluster',
    targetId: `${stack}/${cluster}`,
    metadata: { secret: next, version, redeployed },
  });
  return { cluster, secret: next, version, redeployed };
}

/**
 * One live cluster member with its Docker-truth role + health + replication
 * lag. Canonical shape appended to `@swarmy/core` views (slice A2) so the
 * dashboard types come from core, never a redeclaration.
 */
export type DbMemberView = DbClusterMemberView;

export interface DbClusterView {
  name: string;
  engine: DbEngine;
  /**
   * Apps wired to this cluster whose image has no `/bin/sh`: they get
   * `<envVar>_FILE` (the secret file) instead of `<envVar>` and must read the
   * URL from that file. Absent when every wired app gets the plain env var name.
   */
  fileDelivered?: Array<{ service: string; envVar: string }>;
  primary: { service: string; status: InvServiceStatus | 'absent' };
  replicas: { desired: number; running: number };
  /** Single-writer endpoint (swarm DNS name of the primary service). */
  rwHost: string;
  /** Read endpoint (swarm DNS name of the replica service; RR across tasks). */
  roHost: string;
  /** Declared replica count from the `swarmy.db.replicas` label (worker target). */
  declaredReplicas: number;
  /** Selected HA topology (the changeable `swarmy.db.topology` anchor label). */
  topology: DbTopology;
  /** Every live member of the cluster with its role + health (per-node roles). */
  members: DbMemberView[];
  /** failover: the leader the reconcile last observed (`swarmy.db.leader`). */
  leader?: string;
  /** PITR (A2): WAL archiving requested (`swarmy.db.backup.pitr=true` on the primary). */
  pitr: boolean;
  /** PITR (A2): the per-cluster wal-shipper sidecar, when provisioned. */
  walShipper?: DbWalShipperView;
  /** Worst replica lag across members this tick (seconds), when measured. */
  maxLagSeconds?: number;
  /** geo: the node-label region the single writer is pinned to. */
  writeRegion?: string;
  /** geo: declared per-region read-replica counts (`swarmy.db.region.<r>.replicas`). */
  regionReplicas?: Record<string, number>;
  /** active-active: declared number of writable primaries. */
  primaries?: number;
  /**
   * A failover the reconcile HELD because no replica is provably caught up
   * (`swarmy.db.failover.pending`): the target it would promote and the
   * data-loss window (bytes / seconds behind the primary's last flushed LSN).
   * Present ⇒ the dashboard shows the window and an admin confirms via
   * {@link confirmFailover}. See @swarmy/core `decideFailover`.
   */
  pendingFailover?: PendingFailover;
  /**
   * Where the primary's data lives. `unmounted` = the legacy data-loss layout
   * (anonymous volume) — the dashboard warns and offers Migrate storage.
   */
  storage?: DbStorageState;
}

export interface DbTopologyView {
  stack: string;
  clusters: DbClusterView[];
}

/** Read the managed-DB topology for a stack straight off the live inventory. */
export function getDbTopology(ctx: OrgContext, stack: string): DbTopologyView {
  const stackServices = liveStackServices(ctx, stack);
  const svcs = stackServices.filter(
    (s) => s.labels[DB_CLUSTER_LABEL] && s.labels[DB_ENGINE_LABEL],
  );
  // wal-shipper sidecars carry the cluster label but no engine label — they are
  // PITR infrastructure, surfaced separately rather than as Postgres members.
  const shippers = stackServices.filter((s) => s.labels[DB_WAL_SHIPPER_LABEL] === 'true');
  const byCluster = new Map<string, InvService[]>();
  for (const s of svcs) {
    const c = s.labels[DB_CLUSTER_LABEL]!;
    const list = byCluster.get(c) ?? [];
    list.push(s);
    byCluster.set(c, list);
  }

  const clusters: DbClusterView[] = [];
  for (const [name, members] of byCluster) {
    const primary = members.find(
      (s) => s.labels[DB_ROLE_LABEL] === 'primary' && !s.labels[DB_MEMBER_LABEL],
    );
    // The base (unregioned) replica is the legacy rw/ro anchor; geo siblings extra.
    const replica =
      members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica' && !s.labels[DB_REGION_LABEL]) ??
      members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica');
    const anchorLabels = primary?.labels ?? replica?.labels;
    const declared = Number(
      primary?.labels[DB_REPLICAS_LABEL] ?? replica?.labels[DB_REPLICAS_LABEL] ?? '0',
    );
    const topology = topologyOf(anchorLabels);
    const writeRegion = primary?.labels[DB_WRITE_REGION_LABEL];
    const leader = primary?.labels[DB_LEADER_LABEL];
    const regionReplicas = parseRegionReplicas(primary?.labels ?? {});
    const primariesDeclared = Number.parseInt(primary?.labels[DB_PRIMARIES_LABEL] ?? '', 10);

    // Replication lag: the reconcile stamps `swarmy.db.lag.<member>` seconds on
    // the primary each tick — one anchor read yields every member's lag.
    const lagByMember = parseLagLabels(primary?.labels);
    const pitr = primary?.labels[DB_BACKUP_PITR_FLAG_LABEL] === 'true';
    const shipper = shippers.find((s) => s.labels[DB_CLUSTER_LABEL] === name);

    const memberViews: DbMemberView[] = members
      .map((s): DbMemberView => {
        const role = s.labels[DB_ROLE_LABEL];
        const lag = lagByMember[s.name];
        return {
          service: s.name,
          role: role === 'primary' || role === 'dcs' ? role : 'replica',
          region:
            s.labels[DB_REGION_LABEL] ??
            (role === 'primary' ? s.labels[DB_WRITE_REGION_LABEL] : undefined),
          status: s.status,
          desired: s.replicas.desired,
          running: s.replicas.running,
          ...(lag !== undefined ? { lagSeconds: lag } : {}),
        };
      })
      .sort((a, b) => a.service.localeCompare(b.service));

    const primaryLive = primary ? liveSwarmService(ctx, primary.name) : undefined;
    const storage = primaryLive ? dbStorageState(primaryLive) : undefined;

    const pendingFailover = members
      .map((s) => parsePendingFailover(s.labels[DB_FAILOVER_PENDING_LABEL]))
      .find((p): p is PendingFailover => p !== null);

    const measuredLags = memberViews
      .map((m) => m.lagSeconds)
      .filter((v): v is number => v !== undefined);

    const fileDelivered = liveStackServices(ctx, stack)
      .filter((s) => s.labels[DB_INJECT_LABEL] === name)
      .map((s) => ({ service: s.name, envVar: s.labels[DB_INJECT_VAR_LABEL] || 'DATABASE_URL', filed: secretEnvFileNames(s.labels) }))
      .filter((a) => a.filed.includes(a.envVar))
      .map(({ service, envVar }) => ({ service, envVar }));

    clusters.push({
      name,
      engine: 'postgres',
      primary: {
        service: primary?.name ?? primaryServiceName(stack, name),
        status: primary?.status ?? 'absent',
      },
      replicas: {
        desired: replica?.replicas.desired ?? 0,
        running: replica?.replicas.running ?? 0,
      },
      rwHost: primary?.name ?? primaryServiceName(stack, name),
      roHost: replica?.name ?? replicaServiceName(stack, name),
      declaredReplicas: Number.isFinite(declared) ? declared : 0,
      topology,
      members: memberViews,
      pitr,
      ...(shipper ? { walShipper: { service: shipper.name, status: shipper.status } } : {}),
      ...(fileDelivered.length > 0 ? { fileDelivered } : {}),
      ...(measuredLags.length > 0 ? { maxLagSeconds: Math.max(...measuredLags) } : {}),
      ...(leader ? { leader } : {}),
      ...(writeRegion ? { writeRegion } : {}),
      ...(Object.keys(regionReplicas).length > 0 ? { regionReplicas } : {}),
      ...(Number.isFinite(primariesDeclared) && primariesDeclared >= 2
        ? { primaries: primariesDeclared }
        : {}),
      ...(storage ? { storage } : {}),
      ...(pendingFailover ? { pendingFailover } : {}),
    });
  }

  clusters.sort((a, b) => a.name.localeCompare(b.name));
  return { stack, clusters };
}

/**
 * Scale a cluster's read replicas to N. Updates the declared `swarmy.db.replicas`
 * label (so the reconcile worker holds the new target) AND scales immediately for
 * instant feedback. Also stamps the label on the primary so reads of either
 * member surface the declared count.
 */
export async function setReplicas(
  ctx: OrgContext,
  input: { stack: string; cluster: string; replicas: number },
): Promise<{ cluster: string; replicas: number }> {
  const replicas = Math.max(0, Math.floor(input.replicas));
  const { primary, replica } = findCluster(ctx, input.stack, input.cluster);
  if (!replica && !primary) throw notFound('db cluster', input.cluster);
  const node = await resolveManagerNode(ctx);

  try {
    for (const svc of [primary, replica]) {
      if (!svc) continue;
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: { [DB_REPLICAS_LABEL]: String(replicas) },
        removeKeys: [],
      });
    }
    if (replica) {
      await ctx.hub.dispatch(node.id, 'service.scale', { service: replica.name, replicas });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { cluster: input.cluster, replicas };
}

/**
 * Confirm a failover the reconcile HELD because promoting could lose the last
 * writes (no replica provably caught up — see @swarmy/core `decideFailover`).
 * The admin names the replica to promote and the data-loss window they saw
 * (`acceptBehindBytes`, or `'unknown'` when it couldn't be measured). This only
 * stamps `swarmy.db.failover.confirm` on the member holding the pending
 * failover; the manageddb-reconcile worker promotes on its next tick, and ONLY
 * if the window is still within what was accepted (a growing gap voids the
 * confirmation). Gated by `abacProcedure('data.failover')`; audited here as
 * the business event.
 */
export async function confirmFailover(
  ctx: OrgContext,
  input: { stack: string; cluster: string; target: string; acceptBehindBytes: number | 'unknown' },
): Promise<{ cluster: string; target: string; acceptBehindBytes: number | 'unknown' }> {
  const { members } = findCluster(ctx, input.stack, input.cluster);
  if (members.length === 0) throw notFound('db cluster', input.cluster);
  const holder = members.find((s) => parsePendingFailover(s.labels[DB_FAILOVER_PENDING_LABEL]));
  const pending = holder ? parsePendingFailover(holder.labels[DB_FAILOVER_PENDING_LABEL]) : null;
  if (!holder || !pending) {
    throw commandRejected(`${input.cluster} has no failover waiting for confirmation`);
  }
  const target = members.find((s) => s.name === input.target);
  if (!target || target.labels[DB_ROLE_LABEL] !== 'replica') {
    throw commandRejected(`${input.target} is not a replica of ${input.cluster}`);
  }
  // Confirming the held target: the accepted window must cover what swarmy showed.
  if (input.target === pending.target) {
    const covers =
      input.acceptBehindBytes === 'unknown' ||
      (pending.behindBytes !== null && input.acceptBehindBytes >= pending.behindBytes);
    if (!covers) {
      throw commandRejected(
        `the data-loss window is now ${pending.behindBytes === null ? 'unknown' : `${pending.behindBytes} bytes`} — review it again before confirming`,
      );
    }
  }
  const node = await resolveManagerNode(ctx);
  const at = new Date().toISOString();
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: holder.name,
      add: {
        [DB_FAILOVER_CONFIRM_LABEL]: encodeFailoverConfirmation({
          target: input.target,
          acceptBehindBytes: input.acceptBehindBytes,
          by: ctx.user.id,
          at,
        }),
      },
      removeKeys: [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'db.failover.confirm',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: {
      target: input.target,
      acceptBehindBytes: input.acceptBehindBytes,
      pendingTarget: pending.target,
      pendingBehindBytes: pending.behindBytes,
      pendingBehindSeconds: pending.behindSeconds,
      reason: pending.reason,
    },
  });
  return { cluster: input.cluster, target: input.target, acceptBehindBytes: input.acceptBehindBytes };
}

/**
 * Select (or change, in-situ) a cluster's HA topology. Pure Docker-truth: this
 * only stamps the `swarmy.db.topology` anchor label on every live member; the
 * manageddb-reconcile worker then CONVERGES the live member set to match —
 * enabling controller-decided promotion (failover), per-region read replicas
 * (geo), or extra primaries (active-active), and tearing down infra that the new
 * topology no longer needs. single/primary-replica behave exactly as before.
 *
 * Switching to `geo` with no `swarmy.db.writeRegion` set yet leaves the primary
 * where it is until {@link setWriteRegion} is called; switching to `active-active`
 * defaults to 2 primaries until {@link setReplicas}-style `swarmy.db.primaries` is
 * raised. Both are safe no-ops on the reconcile until their inputs are declared.
 */
/** Whether `failover` is honest for this cluster now, and why not (the UI shows it). */
export function getFailoverReadiness(
  ctx: OrgContext,
  input: { stack: string; cluster: string },
): ReturnType<typeof failoverReadiness> {
  const { primary, members } = findCluster(ctx, input.stack, input.cluster);
  if (members.length === 0) throw notFound('db cluster', input.cluster);
  const readyNodes = readyServerCount(ctx.hub.nodeInventory(ctx.activeOrgId));
  const replicas = Number.parseInt(primary?.labels[DB_REPLICAS_LABEL] ?? '0', 10) || 0;
  return failoverReadiness({ readyNodes, replicas, primaryPinned: !!primary?.labels[DB_PIN_NODE_LABEL] });
}

export async function setTopology(
  ctx: OrgContext,
  input: {
    stack: string;
    cluster: string;
    topology: DbTopology;
    /** geo: where the single writer lives (applied via setWriteRegion). */
    writeRegion?: string;
    /** geo: per-region read-replica plan (applied via setRegionReplicas). */
    regions?: { region: string; replicas: number }[];
  },
): Promise<{ cluster: string; topology: DbTopology }> {
  if (!(DB_TOPOLOGIES as readonly string[]).includes(input.topology)) {
    throw commandRejected(`unknown topology "${input.topology}"`);
  }
  const { primary, members } = findCluster(ctx, input.stack, input.cluster);
  if (members.length === 0) throw notFound('db cluster', input.cluster);
  if (input.topology === 'failover') {
    // Never offer failover the topology can't honestly provide (QA-058).
    const ready = getFailoverReadiness(ctx, input);
    if (!ready.ok) throw commandRejected(ready.reason);
  }
  const node = await resolveManagerNode(ctx);

  const add: Record<string, string> = { [DB_TOPOLOGY_LABEL]: input.topology };
  // active-active needs at least 2 writers; seed the count on the primary so the
  // reconcile has a target the moment the topology flips (raise it via the label).
  if (input.topology === 'active-active' && primary && !primary.labels[DB_PRIMARIES_LABEL]) {
    add[DB_PRIMARIES_LABEL] = '2';
  }
  try {
    for (const svc of members) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        // Only the primary carries cluster-wide declarations (primaries count);
        // replicas/siblings just get the topology marker so reads stay coherent.
        add: svc === primary ? add : { [DB_TOPOLOGY_LABEL]: input.topology },
        removeKeys: [],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  // geo: fold the write-region + per-region replica plan in atomically so the UI's
  // single setTopology call fully provisions the geo shape (the reconcile converges).
  if (input.topology === 'geo') {
    if (input.writeRegion?.trim()) {
      await setWriteRegion(ctx, { stack: input.stack, cluster: input.cluster, region: input.writeRegion });
    }
    for (const r of input.regions ?? []) {
      if (r.region.trim()) {
        await setRegionReplicas(ctx, { stack: input.stack, cluster: input.cluster, region: r.region, replicas: r.replicas });
      }
    }
  }
  return { cluster: input.cluster, topology: input.topology };
}

/**
 * Geo: pin the single writer to a node-label region (`swarmy.region==<region>`).
 * Stamps `swarmy.db.writeRegion` on the primary; the reconcile re-places the
 * primary onto a node in that region (it tracks the last placement in
 * `swarmy.db.placedRegion`, so steady state is a no-op).
 */
export async function setWriteRegion(
  ctx: OrgContext,
  input: { stack: string; cluster: string; region: string },
): Promise<{ cluster: string; writeRegion: string }> {
  const region = input.region.trim();
  if (!region) throw commandRejected('region is required');
  const { primary, members } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const node = await resolveManagerNode(ctx);
  try {
    // Stamp on the primary (placement source) + every member (so the canvas/detail
    // sheet can render the write-region without resolving the anchor).
    for (const svc of members) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: { [DB_WRITE_REGION_LABEL]: region },
        removeKeys: [],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { cluster: input.cluster, writeRegion: region };
}

/**
 * Geo: declare N read replicas pinned to a region. Stamps (or, for n=0, clears)
 * `swarmy.db.region.<region>.replicas` on the primary (the declaration holder);
 * the reconcile materialises a region-pinned replica sibling
 * `<stack>_<cluster>-replica-<region>` and converges its count — the exact
 * per-region placement model the region-reconcile worker uses for app services.
 */
export async function setRegionReplicas(
  ctx: OrgContext,
  input: { stack: string; cluster: string; region: string; replicas: number },
): Promise<{ cluster: string; region: string; replicas: number }> {
  const region = input.region.trim();
  if (!region) throw commandRejected('region is required');
  const replicas = Math.max(0, Math.floor(input.replicas));
  const { primary } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);
  const node = await resolveManagerNode(ctx);
  const key = regionReplicasLabelKey(region);
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: replicas > 0 ? { [key]: String(replicas) } : {},
      removeKeys: replicas > 0 ? [] : [key],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { cluster: input.cluster, region, replicas };
}

/** Derive the read-only env var name from the writer var (DATABASE_URL → DATABASE_RO_URL). */
export function roVarName(envVar: string): string {
  return envVar.endsWith('_URL') ? `${envVar.slice(0, -4)}_RO_URL` : `${envVar}_RO`;
}

export interface InjectConnectionInput {
  stack: string;
  /** The app service (id or name) to wire to the cluster. */
  appService: string;
  cluster: string;
  /** Writer env var name (default DATABASE_URL); RO var derived from it. */
  envVar?: string;
}

/**
 * Wire an app service to a managed cluster: stamp a DATABASE_URL-style env
 * pointing at the rw host (primary) + a *_RO_URL pointing at the ro host
 * (replica), attach the app to the cluster overlay network, and mark the wiring
 * with `swarmy.db.inject` labels.
 *
 * Env changes require a redeploy, so this patches the app's FULL live spec
 * (`patchLiveService`: service.inspect → merge env/network/labels → deploy) —
 * volumes, command, placement etc. are carried, never dropped.
 */
export async function injectConnection(
  ctx: OrgContext,
  input: InjectConnectionInput,
  /** Rotation: the NEW password + secret, already known (no re-read). */
  known?: { password: string; passwordSecret: string },
): Promise<{ appService: string; cluster: string; envVar: string; roVar: string; rwUrl: string; roUrl: string }> {
  const envVar = (input.envVar ?? 'DATABASE_URL').trim() || 'DATABASE_URL';
  const roVar = roVarName(envVar);

  if (!known) {
    // A legacy (plain-env) cluster moves onto its password secret first.
    const { primary } = findCluster(ctx, input.stack, input.cluster);
    if (primary && !primary.labels[DB_PASSWORD_SECRET_LABEL]) {
      await migrateDbCredentials(ctx, { stack: input.stack, cluster: input.cluster }).catch(() => undefined);
    }
  }
  const { primary, replica } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);

  const app = liveStackServices(ctx, input.stack).find(
    (s) => s.id === input.appService || s.name === input.appService,
  );
  if (!app) throw notFound('service', input.appService);

  const primaryEnv = envRecord(primary);
  const database = primaryEnv[PG_ENV.database] ?? DEFAULT_DATABASE;
  const rwHost = primary.name;
  const roHost = replica?.name ?? primary.name; // fall back to primary if no replica yet
  const url = (host: string, pw: string) => `postgres://postgres:${pw}@${host}:${PG_PORT}/${database}`;
  const network = clusterNetworkName(input.stack, input.cluster);

  // The URLs embed the password, so they are Docker SECRETS delivered as env
  // by the agent's secret-env shim (`secretEnv`): the spec names the secret,
  // never the value. Versioned with the password secret, so a rotation mints
  // new ones.
  const passwordSecret = known?.passwordSecret ?? primary.labels[DB_PASSWORD_SECRET_LABEL];
  const version = passwordSecret ? parseDbSecretName(passwordSecret)?.version ?? 1 : 1;
  const rwSecret = dbSecretName(input.stack, input.cluster, 'url', version);
  const roSecret = dbSecretName(input.stack, input.cluster, 'ro-url', version);
  const node = await resolveManagerNode(ctx);
  const password = known?.password ?? (await readDbPassword(ctx, input.stack, input.cluster));
  await createDbSecret(ctx, node.id, input.stack, input.cluster, 'url', rwSecret, url(rwHost, password));
  await createDbSecret(ctx, node.id, input.stack, input.cluster, 'ro-url', roSecret, url(roHost, password));
  const urlFamilies = new Set([
    dbSecretFamily(input.stack, input.cluster, 'url'),
    dbSecretFamily(input.stack, input.cluster, 'ro-url'),
  ]);

  // One-aspect patch over the FULL live spec (service.inspect): mounts,
  // command, placement, resources, … all survive the redeploy.
  await patchLiveService(ctx, app, {
    // Any plaintext copy (a pre-secret attach) goes.
    removeEnv: [envVar, roVar],
    addNetworks: [network],
    setLabels: {
      [MANAGED_LABEL]: 'true',
      [STACK_LABEL]: input.stack,
      [DB_INJECT_LABEL]: input.cluster,
      [DB_INJECT_VAR_LABEL]: envVar,
    },
    transform: (spec) => ({
      ...spec,
      secrets: [
        ...(spec.secrets ?? []).filter((r) => {
          const fam = parseDbSecretName(r.source)?.family;
          const t = r.target ?? r.source;
          return !(fam && urlFamilies.has(fam)) && t !== envVar && t !== roVar;
        }),
        { source: rwSecret, target: envVar },
        { source: roSecret, target: roVar },
      ],
      secretEnv: [...new Set([...(spec.secretEnv ?? []), envVar, roVar])].sort(),
      // A shell-less image (distroless) can't run the shim: the agent then sets
      // DATABASE_URL_FILE / _RO_URL_FILE instead — never the plain URL.
      secretEnvFileFallback: [...new Set([...(spec.secretEnvFileFallback ?? []), envVar, roVar])].sort(),
    }),
  });
  return {
    appService: app.name,
    cluster: input.cluster,
    envVar,
    roVar,
    rwUrl: url(rwHost, '***'),
    roUrl: url(roHost, '***'),
  };
}

// ── Storage migration (legacy anonymous-volume clusters → named volume + pin) ──

/**
 * Rebuild a DB member's spec from live truth: image, env, networks, labels and
 * secrets, with its storage layout re-derived from its labels. Configs are NOT
 * carried (the only one is the PITR conf, which needs its target path) — callers
 * drop the `swarmy.db.pitr.applied` marker so the reconcile re-applies it.
 */
export function rebuildDbMemberSpec(
  live: SwarmServiceInfo,
  labels: Record<string, string>,
  replicas: number,
): ServiceSpec {
  const networks = (live.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const env: Record<string, string> = {};
  for (const kv of live.env ?? []) {
    const i = kv.indexOf('=');
    env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return applyPgMember<ServiceSpec>(
    {
      name: live.name,
      image: live.image,
      mode: { replicated: { replicas } },
      env,
      labels,
      networks,
      ...((live.secrets ?? []).length > 0 ? { secrets: live.secrets.map((n) => ({ source: n })) } : {}),
    },
    labels,
  );
}

export interface MigrateStorageInput {
  stack: string;
  cluster: string;
  /** Skip the pre-migration pg_dump (only when no backup destination exists). */
  skipBackup?: boolean;
  /**
   * Keep accepting writes while the physical copy runs. Default `false`: the
   * primary is put in `default_transaction_read_only` for the copy so nothing
   * committed after the basebackup can be lost at cutover. With `true` the
   * primary stays writable and writes committed between the end of the copy and
   * the cutover (typically seconds) are NOT carried over.
   */
  allowWritesDuringCopy?: boolean;
}

/** What the pre-migration logical backup does — and does not — cover. */
export interface MigrateBackupScope {
  engine: 'pg_dump';
  /** Databases the dump holds (only the cluster's app database). */
  databases: string[];
  /** Plain-words limits for the UI. */
  note: string;
}

export interface MigrateStorageResult {
  cluster: string;
  /** `already` = nothing to do; `adopted` = labels stamped on an existing mount. */
  outcome: 'migrated' | 'already' | 'adopted';
  dataVolume: string;
  pinnedNode: string;
  /** The legacy anonymous volume (swarm removes it with the old task at cutover). */
  sourceVolume?: string;
  backupSnapshotId?: string;
  backupScope?: MigrateBackupScope;
  /** Whether writes were frozen during the copy (lossless) or allowed (see input). */
  writesFrozen?: boolean;
}

/** Test seam: poll cadence / deadlines (defaults are production values). */
export interface MigrateStorageTiming {
  pollMs?: number;
  cutoverWaitMs?: number;
  copyTimeoutMs?: number;
}

const CUTOVER_POLL_MS = 3_000;
const CUTOVER_WAIT_MS = 5 * 60_000;
const COPY_TIMEOUT_MS = 60 * 60_000;
const MIGRATE_EXEC_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SQL run as the superuser from a one-shot client container on the cluster
 * overlay (`$SRC_HOST` = the primary service, `PGPASSWORD` in env). Over the
 * network rather than `exec` into the primary: exec is an opt-in agent
 * capability that is off by default, and a platform operation must not need it.
 */
const psqlInContainer = (sql: string) =>
  `psql -h "$SRC_HOST" -U postgres -d postgres -w -v ON_ERROR_STOP=1 -tA ${sql}`;
export const FREEZE_WRITES_SCRIPT = psqlInContainer(
  `-c "ALTER SYSTEM SET default_transaction_read_only = on" -c "SELECT pg_reload_conf()"`,
);
export const THAW_WRITES_SCRIPT = psqlInContainer(
  `-c "ALTER SYSTEM RESET default_transaction_read_only" -c "SELECT pg_reload_conf()"`,
);
/** Prints `false|off` on a writable, non-recovering primary. */
export const WRITER_CHECK_SCRIPT = psqlInContainer(
  `-c "SELECT pg_is_in_recovery()::text || '|' || current_setting('default_transaction_read_only')"`,
);

/**
 * The `container.runOnce` payload of the ONLINE physical copy. Pure — exported
 * for the golden test. Runs in the primary's own image (pg_basebackup matches
 * the server major; already on the node, so no pull), on the cluster overlay so
 * it resolves the primary by swarm DNS, with the named volume mounted at the
 * data root. The replication credential rides container env only.
 */
export function basebackupRunOncePayload(input: {
  image: string;
  primaryService: string;
  network: string;
  dataVolume: string;
  replicationUser: string;
  replicationPassword: string;
  stamp: string;
  timeoutMs?: number;
}): RunOncePayloadInput {
  return {
    image: input.image,
    entrypoint: ['/bin/sh', '-c'],
    cmd: [storageBasebackupScript(input.stamp)],
    env: {
      SRC_HOST: input.primaryService,
      PGUSER: input.replicationUser,
      PGPASSFILE: PG_ONESHOT_PASSFILE_PATH,
    },
    // The credential is a 0600 file put in before start — never container env.
    secretFiles: [{ ...PG_ONESHOT_PASSFILE, contents: pgPassfileLine(input.replicationPassword), mode: 0o600, uid: 0, gid: 0 }],
    binds: [`${input.dataVolume}:${MANAGED_PG_ROOT}`],
    networks: [input.network],
    // root: move aside + chown to the image's postgres user after the copy.
    user: '0:0',
    pull: false,
    timeoutMs: input.timeoutMs ?? COPY_TIMEOUT_MS,
  };
}
type RunOncePayloadInput = Omit<RunOncePayload, 'commandId'>;

/**
 * Move a legacy cluster (primary on an ANONYMOUS volume — any restart would
 * start it empty) onto the persistent layout WITHOUT EVER STOPPING the primary
 * before a verified copy exists:
 *
 *   0. preflight (nothing touched): running task + node, replication creds,
 *   1. pg_dump safety net via the DB-backup path (app database only — the
 *      physical copy is what carries every database/role),
 *   2. freeze writes (`default_transaction_read_only`, unless opted out),
 *   3. ONLINE `pg_basebackup` from the running primary into
 *      `<stack>_<cluster>-primary-data` on the primary's CURRENT node (a
 *      runOnce on that node's agent, on the cluster overlay), verified by exit
 *      0 + `data/PG_VERSION`,
 *   4. cutover: redeploy the primary mounted + pinned to that node, then wait
 *      for a writable, non-recovering writer on the named volume,
 *   5. replicas onto their per-node volume + anti-affinity (they re-sync).
 *
 * Why online: swarm REMOVES a stopped task's container together with its
 * anonymous volumes, so a stop-then-copy finds nothing to copy — and mounting
 * the anonymous volume "by name" afterwards silently creates an EMPTY volume
 * that the image initdb's. This flow therefore never stops the primary before
 * the copy is verified, and never rolls back by mounting a volume by name.
 *
 * Failure before cutover: writes are thawed, nothing else was touched (the
 * primary never stopped). Failure at/after cutover: no automatic rollback
 * (re-deploying the legacy spec would start a task on a FRESH anonymous volume
 * — an empty database); the error names the verified copy's volume + node and
 * the backup snapshot for manual recovery.
 */
export async function migrateStorage(
  ctx: OrgContext,
  input: MigrateStorageInput,
  timing: MigrateStorageTiming = {},
): Promise<MigrateStorageResult> {
  const { stack, cluster } = input;
  const pollMs = timing.pollMs ?? CUTOVER_POLL_MS;
  const { primary, replica } = findCluster(ctx, stack, cluster);
  if (!primary) throw notFound('db cluster primary', cluster);
  const live = liveSwarmService(ctx, primary.name);
  if (!live) throw notFound('db cluster primary', cluster);
  const storage = dbStorageState(live);
  const manager = await resolveManagerNode(ctx);
  const target = primaryDataVolumeName(stack, cluster);

  if (storage.state === 'unknown') {
    throw commandRejected(
      'cannot see this primary\'s mounts — the node agent is too old. Update the agent, then retry.',
    );
  }
  const task = runningTaskOf(ctx, live);
  if (storage.state === 'persistent') {
    if (!storage.undeclared && storage.pinnedNode) {
      return { cluster, outcome: 'already', dataVolume: storage.dataVolume!, pinnedNode: storage.pinnedNode };
    }
    // Mounted but undeclared/unpinned: adopt the live volume + node on labels.
    const pin = storage.pinnedNode ?? (task ? ctx.hub.swarmNodeIdFor(task.nodeId) : undefined);
    if (!pin) throw commandRejected('primary has no running task to pin — retry once it is running');
    try {
      await ctx.hub.dispatch(manager.id, 'service.updateLabels', {
        service: live.name,
        add: dbStorageLabels({ dataVolume: storage.dataVolume!, pinNode: pin }),
        // The PITR primary spec re-derives mount + pin from these labels.
        removeKeys: [DB_PITR_APPLIED_LABEL],
      });
    } catch (e) {
      throw mapDispatchError(e);
    }
    return { cluster, outcome: 'adopted', dataVolume: storage.dataVolume!, pinnedNode: pin };
  }

  // ── 0. Preflight — nothing is touched until every check passes.
  if (!task) {
    throw commandRejected(
      'the primary has no running task, so there is nothing live to copy from — nothing was changed. ' +
        'Bring the primary back up (or restore from a backup), then retry.',
    );
  }
  const source = task.container.mounts?.find(
    (m) => m.target === MANAGED_PG_ROOT && (m.type === undefined || m.type === 'volume') && m.source,
  )?.source;
  const pin = ctx.hub.swarmNodeIdFor(task.nodeId);
  if (!pin) throw commandRejected('cannot resolve the swarm node id of the node hosting the primary — nothing was changed');
  const env = envRecord(primary);
  if (pgBootRole(env) === 'replica') {
    throw commandRejected(
      'this primary still runs in replica mode (an in-place failover promotion) — nothing was changed. Re-provision it as a primary first.',
    );
  }
  const replUser = env[PG_ENV.replicationUser] ?? '';
  // The replication role shares the cluster password (its secret, or a legacy env).
  const replPassword =
    env[PG_ENV.replicationPassword] || (await readDbPassword(ctx, stack, cluster).catch(() => ''));
  if (!replUser || !replPassword) {
    throw commandRejected(
      'the primary has no replication credentials (SWARMY_PG_REPLICATION_USER/_PASSWORD) to run pg_basebackup with — nothing was changed',
    );
  }
  const clusterNet = clusterNetworkName(stack, cluster);
  const liveNets = (live.networks ?? []).map((n) => n.name);
  const network = liveNets.includes(clusterNet) ? clusterNet : liveNets[0];
  if (!network) {
    throw commandRejected('the primary is on no overlay network the copy can reach it over — nothing was changed');
  }
  const database = env[PG_ENV.database] ?? DEFAULT_DATABASE;

  // ── 1. Logical safety net — covers the app database ONLY.
  let backupSnapshotId: string | undefined;
  let backupScope: MigrateBackupScope | undefined;
  if (!input.skipBackup) {
    const { runDbBackup } = await import('./dbBackup.service');
    try {
      const run = await runDbBackup(ctx, { stack, cluster, engine: 'pg_dump' });
      backupSnapshotId = run.snapshotId;
      const databases = run.databases && run.databases.length > 0 ? run.databases : [database];
      backupScope = {
        engine: 'pg_dump',
        databases,
        note: `The pre-migration backup is a pg_dump of ${databases.join(', ')} only — other databases, roles and cluster-wide settings are not in it. The physical copy carries everything.`,
      };
    } catch (e) {
      throw commandRejected(
        `pre-migration backup failed, nothing was changed: ${e instanceof Error ? e.message : String(e)} (configure a backup destination, or migrate with skipBackup)`,
      );
    }
  }

  const superPassword = env[PG_ENV.password] || replPassword;
  const sqlOnPrimary = (nodeId: string, script: string) =>
    ctx.hub.dispatch<RunOnceResult>(
      nodeId,
      'container.runOnce',
      {
        image: live.image,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [script],
        env: { SRC_HOST: live.name, PGPASSFILE: PG_ONESHOT_PASSFILE_PATH },
        secretFiles: [{ ...PG_ONESHOT_PASSFILE, contents: pgPassfileLine(superPassword), mode: 0o600, uid: 0, gid: 0 }],
        user: '0:0',
        networks: [network],
        pull: false,
        timeoutMs: MIGRATE_EXEC_TIMEOUT_MS,
      },
      { timeoutMs: MIGRATE_EXEC_TIMEOUT_MS + 30_000 },
    );
  const execPrimary = async (script: string) => {
    const res = await sqlOnPrimary(task.nodeId, script);
    if (res.exitCode !== 0 || res.timedOut) {
      throw new Error(`exit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}: ${(res.output ?? '').trim().slice(-300)}`);
    }
    return res.output ?? '';
  };
  const stillServing = () => {
    const now = liveSwarmService(ctx, live.name);
    const t = now ? runningTaskOf(ctx, now) : undefined;
    return t?.container.id === task.container.id;
  };
  const refs = () =>
    `copy volume ${target} on swarm node ${pin}` +
    (backupSnapshotId ? `; logical backup snapshot ${backupSnapshotId} (database ${database} only)` : '; no logical backup was taken');
  const stamp = String(Date.now());

  // ── 2 + 3. Freeze writes, copy ONLINE, verify. The primary is never stopped.
  const freeze = !input.allowWritesDuringCopy;
  let frozen = false;
  try {
    if (freeze) {
      await execPrimary(FREEZE_WRITES_SCRIPT);
      frozen = true;
    }
    const copy = await ctx.hub.dispatch<RunOnceResult>(
      task.nodeId,
      'container.runOnce',
      basebackupRunOncePayload({
        image: live.image,
        primaryService: live.name,
        network,
        dataVolume: target,
        replicationUser: replUser,
        replicationPassword: replPassword,
        stamp,
        timeoutMs: timing.copyTimeoutMs ?? COPY_TIMEOUT_MS,
      }),
      { timeoutMs: (timing.copyTimeoutMs ?? COPY_TIMEOUT_MS) + 60_000 },
    );
    if (copy.exitCode !== 0 || copy.timedOut || !copy.output.includes(BASEBACKUP_OK_MARKER)) {
      throw new Error(
        `pg_basebackup failed (exit ${copy.exitCode}${copy.timedOut ? ', timed out' : ''}): ${copy.output.trim().slice(-400)}`,
      );
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    let thawNote = '';
    if (frozen) {
      try {
        await execPrimary(THAW_WRITES_SCRIPT);
        thawNote = ' Writes were re-enabled.';
      } catch (te) {
        thawNote =
          ` WARNING: the primary is still READ-ONLY — re-enable writes with ` +
          `\`ALTER SYSTEM RESET default_transaction_read_only; SELECT pg_reload_conf();\` (${te instanceof Error ? te.message : String(te)}).`;
      }
    }
    const serving = stillServing()
      ? 'the primary was never stopped and is still running on its original volume'
      : 'the primary was never stopped by swarmy, but its task is no longer reported running — check it now';
    throw commandRejected(
      `storage migration aborted before cutover; ${serving}.${thawNote} Cause: ${why}`,
    );
  }

  // ── 4. Cutover: redeploy mounted + pinned. The old task (and, with it, its
  //       anonymous volume) is removed by swarm from here on.
  const baseLabels = omit(live.labels, [DB_PITR_APPLIED_LABEL]);
  const primaryLabels = { ...baseLabels, ...dbStorageLabels({ dataVolume: target, pinNode: pin }) };
  try {
    await ctx.hub.dispatch(
      manager.id,
      'service.deploy',
      { spec: rebuildDbMemberSpec(live, primaryLabels, 1), pullPolicy: 'missing' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const now = liveSwarmService(ctx, live.name);
    const specUnchanged = now ? dbStorageState(now).state === 'unmounted' : false;
    if (specUnchanged && stillServing()) {
      // The update never applied: the original task is verifiably still the
      // writer. Nothing to roll back — just lift the write freeze.
      let thawNote = '';
      if (frozen) {
        thawNote = await execPrimary(THAW_WRITES_SCRIPT).then(
          () => ' Writes were re-enabled.',
          (te) =>
            ` WARNING: the primary is still READ-ONLY — run \`ALTER SYSTEM RESET default_transaction_read_only; SELECT pg_reload_conf();\` (${te instanceof Error ? te.message : String(te)}).`,
        );
      }
      throw commandRejected(
        `storage migration cutover did not apply; the primary is still running on its original volume${source ? ` (${source})` : ''}.${thawNote} Verified copy left in place: ${refs()}. Cause: ${why}`,
      );
    }
    throw commandRejected(cutoverFailureMessage(live.name, source, refs(), why));
  }

  // Wait for a writable, non-recovering writer on the named volume.
  const deadline = Date.now() + (timing.cutoverWaitMs ?? CUTOVER_WAIT_MS);
  let lastProblem = 'no running task on the new volume yet';
  for (;;) {
    const now = liveSwarmService(ctx, live.name);
    const t = now ? runningTaskOf(ctx, now) : undefined;
    const onTarget = t?.container.mounts?.some((m) => m.target === MANAGED_PG_ROOT && m.source === target);
    if (t && onTarget) {
      try {
        const res = await sqlOnPrimary(t.nodeId, WRITER_CHECK_SCRIPT);
        const out = (res.output ?? '').trim();
        if (res.exitCode === 0 && out.includes('false|off')) break;
        lastProblem = `writer check returned "${out.slice(-120)}" (exit ${res.exitCode})`;
      } catch (e) {
        lastProblem = `writer check failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (Date.now() > deadline) {
      throw commandRejected(
        cutoverFailureMessage(live.name, source, refs(), `the new primary did not come up writable in time (${lastProblem})`),
      );
    }
    await sleep(pollMs);
  }

  // ── 5. Replicas: per-node volume + anti-affinity; safe to redeploy (they re-sync).
  const replicaLive = replica ? liveSwarmService(ctx, replica.name) : undefined;
  if (replicaLive) {
    const labels = {
      ...replicaLive.labels,
      ...dbStorageLabels({
        dataVolume: replicaLive.labels[DB_DATA_VOLUME_LABEL] ?? replicaDataVolumeName(stack, cluster),
        ...(isMultiNode(ctx) ? { avoidNode: pin } : {}),
      }),
    };
    await ctx.hub
      .dispatch(
        manager.id,
        'service.deploy',
        { spec: rebuildDbMemberSpec(replicaLive, labels, replicaLive.desiredReplicas ?? 0), pullPolicy: 'missing' },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      )
      .catch(() => undefined); // best-effort: the reconcile re-converges replicas
  }

  await writeAudit(ctx, {
    action: 'db.storage.migrate',
    actorType: ctx.user ? 'user' : 'system',
    targetType: 'dbCluster',
    targetId: `${stack}/${cluster}`,
    metadata: {
      method: 'pg_basebackup',
      sourceVolume: source ?? null,
      dataVolume: target,
      pinnedNode: pin,
      writesFrozen: freeze,
      backupSnapshotId: backupSnapshotId ?? null,
    },
  }).catch(() => undefined);

  return {
    cluster,
    outcome: 'migrated',
    dataVolume: target,
    pinnedNode: pin,
    ...(source ? { sourceVolume: source } : {}),
    ...(backupSnapshotId ? { backupSnapshotId } : {}),
    ...(backupScope ? { backupScope } : {}),
    writesFrozen: freeze,
  };
}

/** The loud, never-reassuring message for a failure at/after cutover. */
function cutoverFailureMessage(
  service: string,
  source: string | undefined,
  refs: string,
  why: string,
): string {
  return (
    `STORAGE MIGRATION CUTOVER FAILED — manual recovery needed. ${why}. ` +
    `The primary service ${service} may be down. Its original anonymous volume${source ? ` (${source})` : ''} ` +
    'is removed by swarm together with the old task, so do NOT redeploy the old spec — it would start an EMPTY database. ' +
    `Recover from: ${refs}. The copy was verified (pg_basebackup exit 0, data/PG_VERSION present) before cutover; ` +
    `inspect \`docker service ps ${service} --no-trunc\` and the task logs, and do not remove that volume.`
  );
}

// ── removing a cluster ───────────────────────────────────────────────────────

/** The phrase `db.remove` wants typed: `<stack>/<cluster>`. */
export function dbRemoveConfirmPhrase(stack: string, cluster: string): string {
  return `${stack}/${cluster}`;
}

/**
 * Remove a managed Postgres: every member service (primary, standbys, region
 * siblings, extra primaries) and its WAL shipper. Destructive → the router's
 * `data.destroy` policy gate plus the typed `<stack>/<cluster>` phrase here.
 * Refused while an app is still wired to it (`swarmy.db.inject`), so no app is
 * left with a dead DATABASE_URL. The data volumes are KEPT unless
 * `deleteData` (then removed from every online server — irreversible).
 * Audited as `db.remove`.
 */
export async function removeDb(
  ctx: OrgContext,
  input: { stack: string; cluster: string; confirm: string; deleteData?: boolean },
): Promise<{ cluster: string; removed: string[]; volumesDeleted: string[]; volumesKept: string[] }> {
  const expected = dbRemoveConfirmPhrase(input.stack, input.cluster);
  if (input.confirm.trim() !== expected) {
    throw commandRejected(`type ${expected} to remove this database`);
  }
  const { members } = findCluster(ctx, input.stack, input.cluster);
  if (members.length === 0) throw notFound('db cluster', input.cluster);
  const attached = liveStackServices(ctx, input.stack).filter(
    (s) => s.labels[DB_INJECT_LABEL] === input.cluster && s.labels[DB_CLUSTER_LABEL] !== input.cluster,
  );
  if (attached.length > 0) {
    throw commandRejected(
      `${attached.length} app(s) still use this database (${attached.map((s) => s.name).join(', ')}) — disconnect them first`,
    );
  }
  const shipper = liveSwarmService(ctx, walShipperServiceName(input.stack, input.cluster));
  // Primaries first: with no primary left the reconcile worker has no
  // declaration to re-create replicas from while we remove the rest.
  const ordered = [
    ...members.filter((m) => m.labels[DB_ROLE_LABEL] === 'primary'),
    ...members.filter((m) => m.labels[DB_ROLE_LABEL] !== 'primary'),
  ];
  const toRemove = [...new Set([...ordered.map((m) => m.name), ...(shipper ? [shipper.name] : [])])];
  const volumes = [
    ...new Set([
      primaryDataVolumeName(input.stack, input.cluster),
      replicaDataVolumeName(input.stack, input.cluster),
      walArchiveVolumeName(input.stack, input.cluster),
      ...members.map((m) => m.labels[DB_DATA_VOLUME_LABEL]).filter((v): v is string => Boolean(v)),
    ]),
  ];

  const node = await resolveManagerNode(ctx);
  try {
    for (const name of toRemove) await ctx.hub.dispatch(node.id, 'service.remove', { service: name });
  } catch (e) {
    throw mapDispatchError(e);
  }
  const volumesDeleted: string[] = [];
  if (input.deleteData) {
    // Local volumes live on whichever server ran the task — ask every online one.
    for (const nodeId of ctx.hub.onlineNodeIds()) {
      for (const name of volumes) {
        const ok = await ctx.hub
          .dispatch(nodeId, 'volume.remove', { name, cluster: false })
          .then(() => true, () => false); // absent here = fine
        if (ok && !volumesDeleted.includes(name)) volumesDeleted.push(name);
      }
    }
  }
  await writeAudit(ctx, {
    action: 'db.remove',
    targetType: 'dbCluster',
    targetId: expected,
    metadata: { removed: toRemove, deleteData: Boolean(input.deleteData), volumes },
  });
  return {
    cluster: input.cluster,
    removed: toRemove,
    volumesDeleted,
    volumesKept: input.deleteData ? [] : volumes,
  };
}
