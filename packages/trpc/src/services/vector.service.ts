import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
  type InvService,
  type PgvectorClusterView,
  type VectorAttachmentView,
  type VectorInstanceView,
  type VectorProvisionResult,
  type VectorStatsView,
} from '@swarmy/core';
import type { AttachVectorInput, EnablePgvectorInput, ProvisionVectorInput } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';

/**
 * Managed vector store (slice F5) — a minimal mirror of the A3 managed-cache
 * pattern for qdrant, plus a pgvector enablement path on managed Postgres.
 *
 * Everything is **Docker-truth**: the instance lives in `swarmy.vector.*`
 * service labels, the API key lives in a Docker secret (never in the DB, never
 * returned after provision), and there is NO Prisma model. Instances are
 * private-only — no published ports; apps reach qdrant over the per-instance
 * attachable overlay network by swarm DNS.
 *
 * pgvector: instead of a new engine, pick an existing managed Postgres cluster
 * (manageddb `swarmy.db.*` labels), exec `CREATE EXTENSION IF NOT EXISTS
 * vector` on its primary and stamp `swarmy.vector.pgvector=true`. Apps attach
 * with the ordinary manageddb `injectConnection` (DATABASE_URL) — no separate
 * vector attach path exists for pgvector.
 *
 * The vector-reconcile worker keeps single-replica instances converged and
 * stamps a `swarmy.vector.stats` label (collections sample via exec curl).
 * Label constants + the spec builder are mirrored there (a worker cannot
 * subpath-import an internal @swarmy/trpc module — the same constraint the
 * cache/manageddb reconcile workers document).
 */

// ── Label scheme (Docker-truth; kept in sync with vector-reconcile.ts) ────────
export const VECTOR_KIND_LABEL = 'swarmy.vector.kind';
export const VECTOR_NAME_LABEL = 'swarmy.vector.name';
/** JSON VectorStatsView stamped by the reconcile worker. */
export const VECTOR_STATS_LABEL = 'swarmy.vector.stats';
/** On an APP service: which instance it is wired to + the env var used. */
export const VECTOR_INJECT_LABEL = 'swarmy.vector.inject';
export const VECTOR_INJECT_VAR_LABEL = 'swarmy.vector.inject.var';
/** On a managed-PG primary: the pgvector extension has been enabled. */
export const PGVECTOR_LABEL = 'swarmy.vector.pgvector';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
// manageddb label scheme (read-only here — the clusters the pgvector card lists).
const DB_ENGINE_LABEL = 'swarmy.db.engine';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_MEMBER_LABEL = 'swarmy.db.member';

export const QDRANT_IMAGE = 'qdrant/qdrant:v1.12';
export const VECTOR_PORT = 6333;
/** Secret file target inside the instance (`/run/secrets/vector-api-key`). */
export const VECTOR_SECRET_TARGET = 'vector-api-key';

const DISPATCH_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 30_000;

// ── Naming (all derived from <stack>_<name>) ──────────────────────────────────
export function vectorBaseName(stack: string, name: string): string {
  return `${stack}_${name}`;
}
/** `<stack>_<name>-vector` — the qdrant service; also the DNS host. */
export function vectorServiceName(stack: string, name: string): string {
  return `${vectorBaseName(stack, name)}-vector`;
}
export function vectorNetworkName(stack: string, name: string): string {
  return `${vectorBaseName(stack, name)}-vector-net`;
}
export function vectorDataVolume(stack: string, name: string): string {
  return `${vectorBaseName(stack, name)}-vector-data`;
}
export function vectorKeySecretName(stack: string, name: string): string {
  return `swarmy-vector-${vectorBaseName(stack, name)}-key`;
}

/** URL-safe API key (qdrant `api-key` header value). */
function generateApiKey(): string {
  return randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

// ── Pure: qdrant /collections parser + stats label codec (tested) ─────────────

/**
 * Parse `GET :6333/collections` output → a stats sample. Tolerant of extra
 * fields; returns null when the payload is not a qdrant collections response.
 */
export function parseQdrantCollections(raw: string): Omit<VectorStatsView, 'at'> | null {
  try {
    const json = JSON.parse(raw) as { result?: { collections?: Array<{ name?: unknown }> } };
    const list = json.result?.collections;
    if (!Array.isArray(list)) return null;
    const names = list
      .map((c) => (typeof c?.name === 'string' ? c.name : null))
      .filter((n): n is string => n !== null)
      .sort((a, b) => a.localeCompare(b));
    return { collections: names.length, collectionNames: names };
  } catch {
    return null;
  }
}

/** Encode a stats sample for the `swarmy.vector.stats` label. */
export function encodeVectorStatsLabel(stats: VectorStatsView): string {
  return JSON.stringify({
    collections: stats.collections,
    collectionNames: stats.collectionNames.slice(0, 25),
    at: stats.at,
  });
}

/** Parse the stats label; malformed/foreign JSON degrades to null (no throw). */
export function parseVectorStatsLabel(raw: string | undefined | null): VectorStatsView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<VectorStatsView>;
    if (typeof v.collections !== 'number' || typeof v.at !== 'string') return null;
    return {
      collections: v.collections,
      collectionNames: Array.isArray(v.collectionNames)
        ? v.collectionNames.filter((n): n is string => typeof n === 'string')
        : [],
      at: v.at,
    };
  } catch {
    return null;
  }
}

// ── Spec builder (canonical; mirrored in vector-reconcile.ts) ─────────────────

/**
 * The qdrant service spec. NO ports — private-only, always. The API key never
 * appears in the spec: the container reads the mounted Docker secret at start
 * via a `sh -c` wrapper exporting `QDRANT__SERVICE__API_KEY`.
 */
export function qdrantSpec(stack: string, name: string): ServiceSpec {
  return {
    name: vectorServiceName(stack, name),
    image: QDRANT_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: {
      [MANAGED_LABEL]: 'true',
      [STACK_LABEL]: stack,
      [VECTOR_KIND_LABEL]: 'qdrant',
      [VECTOR_NAME_LABEL]: name,
      // Vector stores must stay warm — never scale-to-zero.
      [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    },
    command: ['sh', '-c'],
    args: [
      `QDRANT__SERVICE__API_KEY="$(cat /run/secrets/${VECTOR_SECRET_TARGET})" exec ./entrypoint.sh`,
    ],
    networks: [vectorNetworkName(stack, name)],
    secrets: [{ source: vectorKeySecretName(stack, name), target: VECTOR_SECRET_TARGET }],
    mounts: [
      { type: 'volume' as const, source: vectorDataVolume(stack, name), target: '/qdrant/storage' },
    ],
  };
}

// ── Live discovery (hub inventory — never the DB) ─────────────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function findInstance(ctx: OrgContext, stack: string, name: string): InvService | undefined {
  return liveOrgServices(ctx).find(
    (s) =>
      s.labels[VECTOR_KIND_LABEL] === 'qdrant' &&
      s.labels[VECTOR_NAME_LABEL] === name &&
      (s.labels[STACK_LABEL] ?? s.stack) === stack,
  );
}

function requireInstance(ctx: OrgContext, stack: string, name: string): InvService {
  const s = findInstance(ctx, stack, name);
  if (!s) throw notFound('vector instance', `${stack}/${name}`);
  return s;
}

function toView(ctx: OrgContext, s: InvService): VectorInstanceView {
  const stack = s.labels[STACK_LABEL] ?? s.stack;
  const name = s.labels[VECTOR_NAME_LABEL] ?? s.name;
  const attachments: VectorAttachmentView[] = liveOrgServices(ctx)
    .filter((a) => a.stack === stack && a.labels[VECTOR_INJECT_LABEL] === name)
    .map((a) => ({ service: a.name, envVar: a.labels[VECTOR_INJECT_VAR_LABEL] ?? 'QDRANT_URL' }))
    .sort((a, b) => a.service.localeCompare(b.service));
  return {
    stack,
    name,
    kind: 'qdrant',
    service: s.name,
    status: s.status,
    desired: s.replicas.desired,
    running: s.replicas.running,
    host: s.name,
    port: VECTOR_PORT,
    url: `http://${s.name}:${VECTOR_PORT}`,
    keySecret: vectorKeySecretName(stack, name),
    stats: parseVectorStatsLabel(s.labels[VECTOR_STATS_LABEL]),
    attachments,
  };
}

/** All managed qdrant instances in the org (Data → Vector page). */
export function listVectorInstances(ctx: OrgContext): VectorInstanceView[] {
  return liveOrgServices(ctx)
    .filter((s) => s.labels[VECTOR_KIND_LABEL] === 'qdrant')
    .map((s) => toView(ctx, s))
    .sort((a, b) => `${a.stack}/${a.name}`.localeCompare(`${b.stack}/${b.name}`));
}

export function getVectorInstance(
  ctx: OrgContext,
  input: { stack: string; name: string },
): VectorInstanceView {
  return toView(ctx, requireInstance(ctx, input.stack, input.name));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Provision a qdrant instance. The API key is generated once, created as a
 * Docker secret (`secret.create`), and returned ONCE here — never persisted
 * controller-side, never retrievable again.
 */
export async function provisionVector(
  ctx: OrgContext,
  input: ProvisionVectorInput,
): Promise<VectorProvisionResult> {
  const stack = input.stack.trim();
  const name = input.name.trim();
  if (!stack || !name) throw commandRejected('stack and name are required');
  if (findInstance(ctx, stack, name)) {
    throw commandRejected(`vector instance "${name}" already exists in stack "${stack}"`);
  }
  const node = await resolveManagerNode(ctx);
  const apiKey = generateApiKey();
  const secretName = vectorKeySecretName(stack, name);
  const dataB64 = Buffer.from(apiKey, 'utf8').toString('base64');
  const secretLabels = { [MANAGED_LABEL]: 'true', [VECTOR_NAME_LABEL]: name };

  try {
    await ctx.hub.dispatch(node.id, 'network.ensure', {
      name: vectorNetworkName(stack, name),
      driver: 'overlay',
      attachable: true,
      labels: { [MANAGED_LABEL]: 'true', [VECTOR_NAME_LABEL]: name },
    });
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    } catch (e) {
      // A stale secret from a previously destroyed instance: replace it.
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: secretName });
      await ctx.hub.dispatch(node.id, 'secret.create', { name: secretName, dataB64, labels: secretLabels });
    }
    await ctx.hub.dispatch(
      node.id,
      'service.deploy',
      { spec: qdrantSpec(stack, name), pullPolicy: 'always' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'vector.provision',
    targetType: 'vectorInstance',
    targetId: vectorBaseName(stack, name),
    metadata: { kind: 'qdrant', image: QDRANT_IMAGE },
  });

  if (input.attachService) {
    // Best-effort: a failed attach must not lose the one-time key reveal.
    await attachVectorToService(ctx, {
      stack,
      name,
      appService: input.attachService,
      envVar: 'QDRANT_URL',
    }).catch(() => undefined);
  }

  const host = vectorServiceName(stack, name);
  return {
    stack,
    name,
    host,
    port: VECTOR_PORT,
    url: `http://${host}:${VECTOR_PORT}`,
    keySecret: secretName,
    apiKey,
  };
}

/**
 * Destroy an instance: remove the service + the key secret. Refused while apps
 * are still attached (unless `force`). The data volume and overlay network are
 * left behind on purpose (inert without the service; the volume may hold data).
 */
export async function destroyVector(
  ctx: OrgContext,
  input: { stack: string; name: string; force?: boolean },
): Promise<{ name: string; removed: true }> {
  const s = requireInstance(ctx, input.stack, input.name);
  const attached = liveOrgServices(ctx).filter(
    (a) => a.stack === input.stack && a.labels[VECTOR_INJECT_LABEL] === input.name,
  );
  if (attached.length > 0 && !input.force) {
    throw commandRejected(
      `${attached.length} service(s) still attached (${attached.map((a) => a.name).join(', ')}) — detach them first or pass force`,
    );
  }
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: s.name });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await ctx.hub
    .dispatch(node.id, 'secret.remove', { name: vectorKeySecretName(input.stack, input.name) })
    .catch(() => undefined);
  await writeAudit(ctx, {
    action: 'vector.destroy',
    targetType: 'vectorInstance',
    targetId: vectorBaseName(input.stack, input.name),
    metadata: { force: Boolean(input.force) },
  });
  return { name: input.name, removed: true };
}

/**
 * Wire an app service to the instance: attach it to the instance overlay
 * network, mount the API-key Docker secret, and set `<VAR>=http://<host>:6333`
 * plus `<VAR-prefix>_API_KEY_FILE=/run/secrets/<secret>`. The key itself never
 * leaves Docker (mirrors cache.attachToService; same lossy-merge caveat —
 * mounts/constraints are not exposed by the live inventory).
 */
export async function attachVectorToService(
  ctx: OrgContext,
  input: AttachVectorInput,
): Promise<{ appService: string; name: string; envVar: string; url: string; apiKeyFileVar: string }> {
  const envVar = input.envVar?.trim() || 'QDRANT_URL';
  const inst = requireInstance(ctx, input.stack, input.name);
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);

  const secretName = vectorKeySecretName(input.stack, input.name);
  const apiKeyFileVar = envVar.endsWith('_URL')
    ? `${envVar.slice(0, -4)}_API_KEY_FILE`
    : `${envVar}_API_KEY_FILE`;
  const url = `http://${inst.name}:${VECTOR_PORT}`;
  const network = vectorNetworkName(input.stack, input.name);

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  env[envVar] = url;
  env[apiKeyFileVar] = `/run/secrets/${secretName}`;

  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels: {
      ...app.labels,
      [STACK_LABEL]: input.stack,
      [VECTOR_INJECT_LABEL]: input.name,
      [VECTOR_INJECT_VAR_LABEL]: envVar,
    },
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: Array.from(new Set([...app.networks.map((n) => n.name), network])),
    secrets: [
      ...(app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
      { source: secretName },
    ],
    ...(app.configs && app.configs.length > 0 ? { configs: app.configs.map((n) => ({ source: n })) } : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'vector.attach',
    targetType: 'vectorInstance',
    targetId: vectorBaseName(input.stack, input.name),
    metadata: { appService: app.name, envVar },
  });
  return { appService: app.name, name: input.name, envVar, url, apiKeyFileVar };
}

/** Unwire an app: drop the env vars, secret ref, network and inject labels. */
export async function detachVectorFromService(
  ctx: OrgContext,
  input: { stack: string; name: string; appService: string },
): Promise<{ appService: string; name: string; detached: true }> {
  requireInstance(ctx, input.stack, input.name);
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);
  if (app.labels[VECTOR_INJECT_LABEL] !== input.name) {
    throw commandRejected(`service "${app.name}" is not attached to "${input.name}"`);
  }

  const envVar = app.labels[VECTOR_INJECT_VAR_LABEL] ?? 'QDRANT_URL';
  const apiKeyFileVar = envVar.endsWith('_URL')
    ? `${envVar.slice(0, -4)}_API_KEY_FILE`
    : `${envVar}_API_KEY_FILE`;
  const secretName = vectorKeySecretName(input.stack, input.name);
  const network = vectorNetworkName(input.stack, input.name);

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    const key = i >= 0 ? kv.slice(0, i) : kv;
    if (key === envVar || key === apiKeyFileVar) continue;
    env[key] = i >= 0 ? kv.slice(i + 1) : '';
  }
  const labels = { ...app.labels };
  delete labels[VECTOR_INJECT_LABEL];
  delete labels[VECTOR_INJECT_VAR_LABEL];

  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels,
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: app.networks.map((n) => n.name).filter((n) => n !== network),
    secrets: (app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
    ...(app.configs && app.configs.length > 0 ? { configs: app.configs.map((n) => ({ source: n })) } : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'vector.detach',
    targetType: 'vectorInstance',
    targetId: vectorBaseName(input.stack, input.name),
    metadata: { appService: app.name },
  });
  return { appService: app.name, name: input.name, detached: true };
}

// ── Stats (live /collections via exec curl; label stamp as fallback) ──────────

/** Shell command sampling qdrant collections with the mounted key file. */
export function vectorStatsCommand(): string {
  return `curl -sf -H "api-key: $(cat /run/secrets/${VECTOR_SECRET_TARGET})" http://127.0.0.1:${VECTOR_PORT}/collections`;
}

/**
 * Live collections sample via the `exec` command (the container holds the key
 * secret — nothing rides the wire). Falls back to the `swarmy.vector.stats`
 * label the reconcile worker stamps.
 */
export async function vectorStats(
  ctx: OrgContext,
  input: { stack: string; name: string },
): Promise<VectorStatsView | null> {
  const s = requireInstance(ctx, input.stack, input.name);
  const fallback = parseVectorStatsLabel(s.labels[VECTOR_STATS_LABEL]);
  const target = resolveExecTarget(ctx, s.name);
  if (!target) return fallback;
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', vectorStatsCommand()],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || !res.output) return fallback;
    const sample = parseQdrantCollections(res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : fallback;
  } catch {
    return fallback;
  }
}

// ── pgvector on managed Postgres ──────────────────────────────────────────────

/**
 * Managed Postgres clusters + whether pgvector is enabled on each (the
 * `swarmy.vector.pgvector` label on the cluster primary).
 */
export function listPgvectorClusters(ctx: OrgContext): PgvectorClusterView[] {
  return liveOrgServices(ctx)
    .filter(
      (s) =>
        s.labels[DB_ENGINE_LABEL] === 'postgres' &&
        s.labels[DB_ROLE_LABEL] === 'primary' &&
        !s.labels[DB_MEMBER_LABEL] &&
        s.labels[DB_CLUSTER_LABEL],
    )
    .map((s) => ({
      stack: s.labels[STACK_LABEL] ?? s.stack,
      cluster: s.labels[DB_CLUSTER_LABEL]!,
      primaryService: s.name,
      status: s.status,
      enabled: s.labels[PGVECTOR_LABEL] === 'true',
    }))
    .sort((a, b) => `${a.stack}/${a.cluster}`.localeCompare(`${b.stack}/${b.cluster}`));
}

/**
 * Enable pgvector on a managed cluster: exec `CREATE EXTENSION IF NOT EXISTS
 * vector` on the primary (bitnami exposes the superuser password + database as
 * container env — nothing rides the wire), then stamp
 * `swarmy.vector.pgvector=true`. Apps then just use their injected
 * DATABASE_URL (manageddb `injectConnection`) — pgvector needs no extra attach.
 */
export async function enablePgvector(
  ctx: OrgContext,
  input: EnablePgvectorInput,
): Promise<{ stack: string; cluster: string; enabled: true }> {
  const primary = liveOrgServices(ctx).find(
    (s) =>
      (s.labels[STACK_LABEL] ?? s.stack) === input.stack &&
      s.labels[DB_CLUSTER_LABEL] === input.cluster &&
      s.labels[DB_ENGINE_LABEL] === 'postgres' &&
      s.labels[DB_ROLE_LABEL] === 'primary' &&
      !s.labels[DB_MEMBER_LABEL],
  );
  if (!primary) throw notFound('db cluster primary', `${input.stack}/${input.cluster}`);
  const target = resolveExecTarget(ctx, primary.name);
  if (!target) throw commandRejected(`no running container for "${primary.name}" — is the cluster up?`);

  const script =
    'PGPASSWORD="$POSTGRESQL_PASSWORD" psql -U postgres -d "${POSTGRESQL_DATABASE:-postgres}" ' +
    '-v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector"';
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', script],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      throw commandRejected(
        `CREATE EXTENSION failed (exit ${res.exitCode}): ${res.output?.slice(0, 300) ?? 'no output'} — the image may not ship pgvector`,
      );
    }
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: { [PGVECTOR_LABEL]: 'true' },
      removeKeys: [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'vector.pgvector.enable',
    targetType: 'dbCluster',
    targetId: `${input.stack}_${input.cluster}`,
    metadata: { primary: primary.name },
  });
  return { stack: input.stack, cluster: input.cluster, enabled: true };
}
