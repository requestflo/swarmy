import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
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

const PG_PORT = 5432;
const REPLICATION_USER = 'repl';
const DEFAULT_DATABASE = 'app';
const DISPATCH_TIMEOUT_MS = 60_000;

export type DbEngine = 'postgres';

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
    primary: members.find((s) => s.labels[DB_ROLE_LABEL] === 'primary'),
    replica: members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica'),
    members,
  };
}

/** Common labels stamped on every DB-role service (primary + replica). */
function dbLabels(
  stack: string,
  cluster: string,
  role: 'primary' | 'replica',
  replicas: number,
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: stack,
    [DB_ENGINE_LABEL]: 'postgres',
    [DB_CLUSTER_LABEL]: cluster,
    [DB_ROLE_LABEL]: role,
    [DB_REPLICAS_LABEL]: String(replicas),
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
}

export interface DbTopologyView {
  stack: string;
  clusters: DbClusterView[];
}

/** Read the managed-DB topology for a stack straight off the live inventory. */
export function getDbTopology(ctx: OrgContext, stack: string): DbTopologyView {
  const svcs = liveStackServices(ctx, stack).filter(
    (s) => s.labels[DB_CLUSTER_LABEL] && s.labels[DB_ENGINE_LABEL],
  );
  const byCluster = new Map<string, InvService[]>();
  for (const s of svcs) {
    const c = s.labels[DB_CLUSTER_LABEL]!;
    const list = byCluster.get(c) ?? [];
    list.push(s);
    byCluster.set(c, list);
  }

  const clusters: DbClusterView[] = [];
  for (const [name, members] of byCluster) {
    const primary = members.find((s) => s.labels[DB_ROLE_LABEL] === 'primary');
    const replica = members.find((s) => s.labels[DB_ROLE_LABEL] === 'replica');
    const declared = Number(
      primary?.labels[DB_REPLICAS_LABEL] ?? replica?.labels[DB_REPLICAS_LABEL] ?? '0',
    );
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
