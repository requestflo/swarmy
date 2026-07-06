import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
  type DbClusterMemberView,
  type DbWalShipperView,
  type InvService,
  type InvServiceStatus,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';

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
 * Engine: bitnami/postgresql, which does primary/replica streaming replication
 * purely from env (`POSTGRESQL_REPLICATION_MODE=master|slave`). We deploy:
 *   - <stack>_<cluster>-primary  (mode=master, 1 replica)
 *   - <stack>_<cluster>-replica  (mode=slave,  N replicas, swarm DNS round-robin)
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
  'failover', // primary-replica + an etcd consensus member + leader observation
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
  /** Number of read replicas (the replica service's desired replica count). */
  replicas: number;
  /** Optional caller-supplied superuser password; generated when omitted. */
  password?: string;
  /** Database created on the primary (default "app"). */
  database?: string;
  /** bitnami/postgresql image tag (default "16"). */
  imageTag?: string;
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
  /**
   * Generated/used superuser password. Returned ONCE here so the caller can
   * surface it; it is NOT stored anywhere outside Docker. See the secret
   * tradeoff note below.
   */
  password: string;
}

/**
 * Provision a managed Postgres cluster on the swarm.
 *
 * Secret tradeoff: bitnami needs the password as env. swarmy has no
 * secret-create agent command yet, so the generated password is set as a
 * **label-free env var** on the service spec (visible via `docker service
 * inspect`, like any compose secret-in-env). Productionising this = a Docker
 * secret (`POSTGRESQL_PASSWORD_FILE`) once a `secret.create` command exists.
 */
export async function provisionDb(
  ctx: OrgContext,
  input: ProvisionDbInput,
): Promise<ProvisionDbResult> {
  if ((input.engine ?? 'postgres') !== 'postgres') {
    throw commandRejected(`unsupported engine "${input.engine}" (only postgres for now)`);
  }
  const stack = input.stack.trim();
  const cluster = input.name.trim();
  if (!stack || !cluster) throw commandRejected('stack and name are required');
  const replicas = Math.max(0, Math.floor(input.replicas));
  const database = (input.database ?? DEFAULT_DATABASE).trim() || DEFAULT_DATABASE;
  const image = `bitnami/postgresql:${input.imageTag ?? '16'}`;
  const node = await resolveManagerNode(ctx);

  const primary = primaryServiceName(stack, cluster);
  const replica = replicaServiceName(stack, cluster);
  const network = clusterNetworkName(stack, cluster);

  // One password reused for the superuser + replication account keeps the slice
  // simple; both services must agree on the replication credential.
  const existing = findCluster(ctx, stack, cluster).primary;
  const password =
    input.password?.trim() ||
    (existing ? envRecord(existing).POSTGRESQL_PASSWORD : '') ||
    generatePassword();

  const primarySpec: ServiceSpec = {
    name: primary,
    image,
    mode: { replicated: { replicas: 1 } },
    labels: dbLabels(stack, cluster, 'primary', replicas),
    env: {
      POSTGRESQL_REPLICATION_MODE: 'master',
      POSTGRESQL_REPLICATION_USER: REPLICATION_USER,
      POSTGRESQL_REPLICATION_PASSWORD: password,
      POSTGRESQL_PASSWORD: password,
      POSTGRESQL_DATABASE: database,
    },
    networks: [network],
  };

  const replicaSpec: ServiceSpec = {
    name: replica,
    image,
    mode: { replicated: { replicas } },
    labels: dbLabels(stack, cluster, 'replica', replicas),
    env: {
      POSTGRESQL_REPLICATION_MODE: 'slave',
      POSTGRESQL_REPLICATION_USER: REPLICATION_USER,
      POSTGRESQL_REPLICATION_PASSWORD: password,
      POSTGRESQL_MASTER_HOST: primary,
      POSTGRESQL_MASTER_PORT_NUMBER: String(PG_PORT),
      POSTGRESQL_PASSWORD: password,
    },
    networks: [network],
  };

  try {
    // Ensure the per-cluster overlay network exists BEFORE deploying onto it —
    // otherwise the service.deploy fails with "network <stack>_<cluster>-net not
    // found" (the reconcile worker also ensures it, but provision must not race
    // that first tick). Idempotent.
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

  return {
    cluster,
    engine: 'postgres',
    primaryService: primary,
    replicaService: replica,
    network,
    rwHost: primary,
    roHost: replica,
    replicas,
    password,
  };
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

    const measuredLags = memberViews
      .map((m) => m.lagSeconds)
      .filter((v): v is number => v !== undefined);

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
      ...(measuredLags.length > 0 ? { maxLagSeconds: Math.max(...measuredLags) } : {}),
      ...(leader ? { leader } : {}),
      ...(writeRegion ? { writeRegion } : {}),
      ...(Object.keys(regionReplicas).length > 0 ? { regionReplicas } : {}),
      ...(Number.isFinite(primariesDeclared) && primariesDeclared >= 2
        ? { primaries: primariesDeclared }
        : {}),
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
 * Select (or change, in-situ) a cluster's HA topology. Pure Docker-truth: this
 * only stamps the `swarmy.db.topology` anchor label on every live member; the
 * manageddb-reconcile worker then CONVERGES the live member set to match —
 * standing up an etcd consensus member (failover), per-region read replicas
 * (geo), or extra primaries (active-active), and tearing down infra that the new
 * topology no longer needs. single/primary-replica behave exactly as before.
 *
 * Switching to `geo` with no `swarmy.db.writeRegion` set yet leaves the primary
 * where it is until {@link setWriteRegion} is called; switching to `active-active`
 * defaults to 2 primaries until {@link setReplicas}-style `swarmy.db.primaries` is
 * raised. Both are safe no-ops on the reconcile until their inputs are declared.
 */
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
 * Env changes require a redeploy, so this re-`service.deploy`s the app merging
 * the new env/network/labels over live truth. Same lossy-merge caveat as
 * service.service.ts#updateService: command/mounts/constraints are not exposed
 * by the live inventory and are not re-applied here.
 */
export async function injectConnection(
  ctx: OrgContext,
  input: InjectConnectionInput,
): Promise<{ appService: string; cluster: string; envVar: string; roVar: string; rwUrl: string; roUrl: string }> {
  const envVar = (input.envVar ?? 'DATABASE_URL').trim() || 'DATABASE_URL';
  const roVar = roVarName(envVar);

  const { primary, replica } = findCluster(ctx, input.stack, input.cluster);
  if (!primary) throw notFound('db cluster primary', input.cluster);

  const app = liveStackServices(ctx, input.stack).find(
    (s) => s.id === input.appService || s.name === input.appService,
  );
  if (!app) throw notFound('service', input.appService);

  const primaryEnv = envRecord(primary);
  const password = primaryEnv.POSTGRESQL_PASSWORD ?? '';
  const database = primaryEnv.POSTGRESQL_DATABASE ?? DEFAULT_DATABASE;
  const rwHost = primary.name;
  const roHost = replica?.name ?? primary.name; // fall back to primary if no replica yet
  const rwUrl = `postgres://postgres:${password}@${rwHost}:${PG_PORT}/${database}`;
  const roUrl = `postgres://postgres:${password}@${roHost}:${PG_PORT}/${database}`;
  const network = clusterNetworkName(input.stack, input.cluster);

  const mergedEnv = { ...envRecord(app), [envVar]: rwUrl, [roVar]: roUrl };
  const networks = Array.from(new Set([...app.networks.map((n) => n.name), network]));

  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels: {
      ...app.labels,
      [MANAGED_LABEL]: 'true',
      [STACK_LABEL]: input.stack,
      [DB_INJECT_LABEL]: input.cluster,
      [DB_INJECT_VAR_LABEL]: envVar,
    },
    env: mergedEnv,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
      mode: 'ingress' as const,
    })),
    networks,
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { appService: app.name, cluster: input.cluster, envVar, roVar, rwUrl, roUrl };
}
