import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  STACK_LABEL,
  SEARCH_ENGINES,
  type InvService,
  type SearchAttachmentView,
  type SearchBackupView,
  type SearchEngine,
  type SearchInstanceView,
  type SearchProvisionResult,
  type SearchStatsView,
} from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import type { AttachSearchInput, ProvisionSearchInput } from '@swarmy/core';
import type {
  BackupVolumeResult,
  ListSnapshotsResult,
  ResticRepo,
  RestoreVolumeResult,
  ServiceSpec,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget } from './live-resolve';

/**
 * Managed search (slice F4) — Meilisearch/Typesense instances mirroring the
 * managed-cache slice, but simpler: single-node v1 with a data volume.
 *
 * Everything is **Docker-truth**: the instance lives in `swarmy.search.*`
 * service labels, the master key lives in a Docker secret (never in the DB,
 * never returned after provision — both engines read it from the mounted
 * secret file via a `sh -c` wrapper, so it never appears in the service spec),
 * and there is NO Prisma model. Instances are private-only — no published
 * ports, ever; apps reach the engine over the per-instance attachable overlay
 * network by swarm DNS.
 *
 * The search-reconcile worker stamps a `swarmy.search.stats` label each tick
 * (docs / indexes / db size sampled inside the container) and fires an alert
 * event when the instance is down. Its label constants + spec builders mirror
 * this file (a worker cannot subpath-import an internal @swarmy/trpc module —
 * the same constraint manageddb/cache-reconcile document).
 */

// ── Label scheme (Docker-truth; kept in sync with search-reconcile.ts) ────────
export const SEARCH_ENGINE_LABEL = 'swarmy.search.engine';
export const SEARCH_CLUSTER_LABEL = 'swarmy.search.cluster';
/** JSON SearchStatsView stamped on the instance by the reconcile worker. */
export const SEARCH_STATS_LABEL = 'swarmy.search.stats';
/** Set while a restore holds the instance at 0 — the reconcile must not wake it. */
export const SEARCH_RESTORING_LABEL = 'swarmy.search.restoring';
/** On an APP service: which instance it is wired to + the host env var used. */
export const SEARCH_INJECT_LABEL = 'swarmy.search.inject';
export const SEARCH_INJECT_VAR_LABEL = 'swarmy.search.inject.var';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';

// ── Engine constants ──────────────────────────────────────────────────────────
export const SEARCH_IMAGES: Record<SearchEngine, string> = {
  meilisearch: 'getmeili/meilisearch:v1.12',
  typesense: 'typesense/typesense:27.1',
};
export const SEARCH_PORTS: Record<SearchEngine, number> = {
  meilisearch: 7700,
  typesense: 8108,
};
export const SEARCH_DATA_DIRS: Record<SearchEngine, string> = {
  meilisearch: '/meili_data',
  typesense: '/data',
};
/** Secret file target inside the instance (`/run/secrets/search-master-key`). */
export const SEARCH_SECRET_TARGET = 'search-master-key';
export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'meilisearch';

const DISPATCH_TIMEOUT_MS = 60_000;
const BACKUP_TIMEOUT_MS = 600_000;
const EXEC_TIMEOUT_MS = 30_000;
/** Bounded wait for a meilisearch dump task before the volume snapshot runs. */
const DUMP_WAIT_SECONDS = 60;

// ── Naming (all derived from <stack>_<name>) ──────────────────────────────────
export function searchBaseName(stack: string, name: string): string {
  return `${stack}_${name}`;
}
/** `<stack>_<name>-search` — the instance; also the DNS host apps connect to. */
export function searchServiceName(stack: string, name: string): string {
  return `${searchBaseName(stack, name)}-search`;
}
/** Per-instance attachable overlay network joining the engine + attached apps. */
export function searchNetworkName(stack: string, name: string): string {
  return `${searchBaseName(stack, name)}-search-net`;
}
/** The instance's data volume — the unit backup.run/backup.restore operate on. */
export function searchDataVolume(stack: string, name: string): string {
  return `${searchBaseName(stack, name)}-search-data`;
}
/**
 * Docker secret carrying the master key: `swarmy-search-<stack>_<name>-key`
 * (stack-qualified — secrets are swarm-global, so two stacks may both have an
 * instance called "main").
 */
export function searchKeySecretName(stack: string, name: string): string {
  return `swarmy-search-${searchBaseName(stack, name)}-key`;
}
/** restic tag identifying the instance's snapshots. */
export function searchBackupTag(stack: string, name: string): string {
  return `search:${searchBaseName(stack, name)}`;
}

/** URL-safe secret (no chars needing escaping in headers or env). */
function generateMasterKey(): string {
  return randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

function searchEngineOf(labels: Record<string, string> | undefined): SearchEngine {
  const v = labels?.[SEARCH_ENGINE_LABEL];
  return (SEARCH_ENGINES as readonly string[]).includes(v ?? '')
    ? (v as SearchEngine)
    : DEFAULT_SEARCH_ENGINE;
}

// ── Pure: stats parsers (tested; mirrored small in search-reconcile.ts) ───────

/** A parsed stats sample (SearchStatsView minus the timestamp). */
export interface SearchStatsSample {
  docs: number;
  indexes: number;
  dbSizeBytes: number | null;
  memoryBytes: number | null;
}

/**
 * Parse meilisearch `GET /stats` JSON → sample. Shape:
 * `{ databaseSize, indexes: { movies: { numberOfDocuments, … }, … } }`.
 * Returns null when the payload does not look like a stats response.
 */
export function parseMeiliStats(raw: string): SearchStatsSample | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { databaseSize?: unknown; indexes?: unknown };
  if (typeof o.indexes !== 'object' || o.indexes === null) return null;
  let docs = 0;
  let indexes = 0;
  for (const idx of Object.values(o.indexes as Record<string, unknown>)) {
    indexes += 1;
    const n = (idx as { numberOfDocuments?: unknown })?.numberOfDocuments;
    if (typeof n === 'number' && Number.isFinite(n)) docs += n;
  }
  return {
    docs,
    indexes,
    dbSizeBytes: typeof o.databaseSize === 'number' ? o.databaseSize : null,
    memoryBytes: null,
  };
}

/**
 * Parse the typesense sample: the stats command prints `GET /collections`
 * (a JSON array with `num_documents`) and `GET /metrics.json` (an object with
 * stringified byte counts) on separate lines — either line may be missing.
 * Returns null when neither line parsed.
 */
export function parseTypesenseStats(raw: string): SearchStatsSample | null {
  let collections: unknown[] | null = null;
  let metrics: Record<string, unknown> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    if (Array.isArray(v)) collections = v;
    else if (typeof v === 'object' && v !== null) metrics = v as Record<string, unknown>;
  }
  if (!collections && !metrics) return null;
  let docs = 0;
  for (const c of collections ?? []) {
    const n = (c as { num_documents?: unknown })?.num_documents;
    if (typeof n === 'number' && Number.isFinite(n)) docs += n;
  }
  const mem = Number(
    metrics?.typesense_memory_active_bytes ?? metrics?.system_memory_used_bytes ?? Number.NaN,
  );
  return {
    docs,
    indexes: collections?.length ?? 0,
    dbSizeBytes: null,
    memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
  };
}

/** Engine-dispatching stats parser (the reconcile + stats proc entry point). */
export function parseSearchStats(engine: SearchEngine, raw: string): SearchStatsSample | null {
  return engine === 'meilisearch' ? parseMeiliStats(raw) : parseTypesenseStats(raw);
}

/** Encode a stats sample for the `swarmy.search.stats` label (stable order). */
export function encodeSearchStatsLabel(stats: SearchStatsView): string {
  return JSON.stringify({
    docs: stats.docs,
    indexes: stats.indexes,
    dbSizeBytes: stats.dbSizeBytes,
    memoryBytes: stats.memoryBytes,
    at: stats.at,
  });
}

/** Parse the stats label; malformed/foreign JSON degrades to null (no throw). */
export function parseSearchStatsLabel(raw: string | undefined | null): SearchStatsView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SearchStatsView>;
    if (typeof v.docs !== 'number' || typeof v.at !== 'string') return null;
    return {
      docs: v.docs,
      indexes: typeof v.indexes === 'number' ? v.indexes : 0,
      dbSizeBytes: typeof v.dbSizeBytes === 'number' ? v.dbSizeBytes : null,
      memoryBytes: typeof v.memoryBytes === 'number' ? v.memoryBytes : null,
      at: v.at,
    };
  } catch {
    return null;
  }
}

// ── Pure: in-container commands (the key never rides the wire) ────────────────

/**
 * Shell script sampling engine stats inside the container, reading the key
 * from the mounted secret file. meilisearch (alpine) tries curl then busybox
 * wget; typesense (ubuntu, no curl) falls back to bash's /dev/tcp.
 */
export function searchStatsCommand(engine: SearchEngine): string {
  // Exported so the `bash -c` /dev/tcp fallback (a subprocess) sees it too.
  const key = `export KEY="$(cat /run/secrets/${SEARCH_SECRET_TARGET})"`;
  if (engine === 'meilisearch') {
    const url = `http://localhost:${SEARCH_PORTS.meilisearch}/stats`;
    return (
      `${key}; curl -fsS -H "Authorization: Bearer $KEY" ${url} 2>/dev/null` +
      ` || wget -qO- --header="Authorization: Bearer $KEY" ${url}`
    );
  }
  const port = SEARCH_PORTS.typesense;
  const get = (path: string): string =>
    `(curl -fsS -H "X-TYPESENSE-API-KEY: $KEY" http://localhost:${port}${path} 2>/dev/null` +
    ` || bash -c 'exec 3<>/dev/tcp/localhost/${port};` +
    ` printf "GET ${path} HTTP/1.0\\r\\nX-TYPESENSE-API-KEY: %s\\r\\n\\r\\n" "$KEY" >&3;` +
    ` sed "1,/^\\r\\{0,1\\}$/d" <&3')`;
  return `${key}; ${get('/collections')}; echo; ${get('/metrics.json')}`;
}

/**
 * Trigger a meilisearch dump (`POST /dumps`, written under the data volume so
 * the following restic snapshot captures it) and wait — bounded — for the dump
 * task to finish. Best-effort: the volume backup still runs if this fails.
 */
export function meiliDumpCommand(): string {
  const base = `http://localhost:${SEARCH_PORTS.meilisearch}`;
  const req = (method: string, path: string): string =>
    `curl -fsS -X ${method} -H "Authorization: Bearer $KEY" ${base}${path} 2>/dev/null` +
    ` || wget -qO- --header="Authorization: Bearer $KEY"` +
    `${method === 'POST' ? ' --post-data=""' : ''} ${base}${path}`;
  return (
    `export KEY="$(cat /run/secrets/${SEARCH_SECRET_TARGET})"; ` +
    `UID_JSON="$(${req('POST', '/dumps')})"; ` +
    `TASK="$(printf '%s' "$UID_JSON" | sed -n 's/.*"taskUid":\\([0-9]*\\).*/\\1/p')"; ` +
    `[ -n "$TASK" ] || exit 0; ` +
    `i=0; while [ "$i" -lt ${DUMP_WAIT_SECONDS} ]; do ` +
    `S="$(${req('GET', '/tasks/$TASK')})"; ` +
    `case "$S" in *'"status":"succeeded"'*|*'"status":"failed"'*|*'"status":"canceled"'*) exit 0;; esac; ` +
    `i=$((i+1)); sleep 1; done`
  );
}

/** Host env vars injected on an attached app (key comes via the secret FILE). */
export function searchAttachEnv(
  engine: SearchEngine,
  host: string,
  secretName: string,
): Record<string, string> {
  if (engine === 'meilisearch') {
    return {
      MEILI_HOST: `http://${host}:${SEARCH_PORTS.meilisearch}`,
      MEILI_MASTER_KEY_FILE: `/run/secrets/${secretName}`,
    };
  }
  return {
    TYPESENSE_HOST: host,
    TYPESENSE_PORT: String(SEARCH_PORTS.typesense),
    TYPESENSE_PROTOCOL: 'http',
    TYPESENSE_API_KEY_FILE: `/run/secrets/${secretName}`,
  };
}

/** The primary host var name recorded in `swarmy.search.inject.var`. */
export function searchInjectVar(engine: SearchEngine): string {
  return engine === 'meilisearch' ? 'MEILI_HOST' : 'TYPESENSE_HOST';
}

// ── Spec builder (canonical; mirrored in search-reconcile.ts) ─────────────────

export interface SearchInstanceDecl {
  stack: string;
  name: string;
  engine: SearchEngine;
}

function searchLabels(decl: SearchInstanceDecl): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: decl.stack,
    [SEARCH_ENGINE_LABEL]: decl.engine,
    [SEARCH_CLUSTER_LABEL]: decl.name,
    // Search engines must stay warm — the idle sleeper must never park them.
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
  };
}

/** Engine start command reading the master key from the mounted secret file. */
export function searchStartCommand(engine: SearchEngine): string {
  if (engine === 'meilisearch') {
    return (
      `export MEILI_MASTER_KEY="$(cat /run/secrets/${SEARCH_SECRET_TARGET})"; ` +
      `export MEILI_ENV=production MEILI_NO_ANALYTICS=true; ` +
      `exec /bin/meilisearch --db-path ${SEARCH_DATA_DIRS.meilisearch} ` +
      `--dump-dir ${SEARCH_DATA_DIRS.meilisearch}/dumps`
    );
  }
  return (
    `exec /opt/typesense-server --data-dir ${SEARCH_DATA_DIRS.typesense} ` +
    `--api-key "$(cat /run/secrets/${SEARCH_SECRET_TARGET})" --enable-cors`
  );
}

/**
 * The single-node instance spec. NO ports — private-only, always. The master
 * key never appears in the spec: the engine mounts the Docker secret at
 * `/run/secrets/search-master-key` and reads it at start via the sh wrapper.
 */
export function searchInstanceSpec(decl: SearchInstanceDecl): ServiceSpec {
  return {
    name: searchServiceName(decl.stack, decl.name),
    image: SEARCH_IMAGES[decl.engine],
    mode: { replicated: { replicas: 1 } },
    labels: searchLabels(decl),
    networks: [searchNetworkName(decl.stack, decl.name)],
    secrets: [
      { source: searchKeySecretName(decl.stack, decl.name), target: SEARCH_SECRET_TARGET },
    ],
    mounts: [
      {
        type: 'volume' as const,
        source: searchDataVolume(decl.stack, decl.name),
        target: SEARCH_DATA_DIRS[decl.engine],
      },
    ],
    command: ['sh', '-c'],
    args: [searchStartCommand(decl.engine)],
  };
}

// ── Live instance discovery (hub inventory — never the DB) ────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

interface LiveInstance {
  stack: string;
  name: string;
  service: InvService;
}

function groupInstances(services: InvService[]): LiveInstance[] {
  const out: LiveInstance[] = [];
  for (const s of services) {
    const name = s.labels[SEARCH_CLUSTER_LABEL];
    // Instance anchors carry engine+cluster; attached apps only carry inject labels.
    if (!name || !s.labels[SEARCH_ENGINE_LABEL] || s.labels[SEARCH_INJECT_LABEL]) continue;
    out.push({ stack: s.labels[STACK_LABEL] ?? s.stack, name, service: s });
  }
  return out;
}

function findInstance(ctx: OrgContext, stack: string, name: string): LiveInstance | undefined {
  return groupInstances(liveOrgServices(ctx)).find((i) => i.stack === stack && i.name === name);
}

function requireInstance(ctx: OrgContext, stack: string, name: string): LiveInstance {
  const i = findInstance(ctx, stack, name);
  if (!i) throw notFound('search instance', `${stack}/${name}`);
  return i;
}

// ── View projection ───────────────────────────────────────────────────────────

function toView(ctx: OrgContext, i: LiveInstance): SearchInstanceView {
  const engine = searchEngineOf(i.service.labels);
  const host = i.service.name;
  const port = SEARCH_PORTS[engine];
  const attachments: SearchAttachmentView[] = liveOrgServices(ctx)
    .filter((s) => s.stack === i.stack && s.labels[SEARCH_INJECT_LABEL] === i.name)
    .map((s) => ({
      service: s.name,
      envVar: s.labels[SEARCH_INJECT_VAR_LABEL] ?? searchInjectVar(engine),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
  return {
    stack: i.stack,
    name: i.name,
    engine,
    service: i.service.name,
    status: i.service.status,
    desired: i.service.replicas.desired,
    running: i.service.replicas.running,
    host,
    port,
    url: `http://${host}:${port}`,
    keySecret: searchKeySecretName(i.stack, i.name),
    stats: parseSearchStatsLabel(i.service.labels[SEARCH_STATS_LABEL]),
    attachments,
  };
}

/** All managed search instances in the org (Data → Search page). */
export function listSearchInstances(ctx: OrgContext): SearchInstanceView[] {
  return groupInstances(liveOrgServices(ctx))
    .map((i) => toView(ctx, i))
    .sort((a, b) => `${a.stack}/${a.name}`.localeCompare(`${b.stack}/${b.name}`));
}

/** One instance's view, straight off the labels. */
export function getSearchInstance(
  ctx: OrgContext,
  input: { stack: string; name: string },
): SearchInstanceView {
  return toView(ctx, requireInstance(ctx, input.stack, input.name));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Provision a managed search instance. The master key is generated once,
 * created as a Docker secret (`secret.create`), and returned ONCE here — it is
 * never persisted controller-side and never retrievable again.
 */
export async function provisionSearch(
  ctx: OrgContext,
  input: ProvisionSearchInput,
): Promise<SearchProvisionResult> {
  const stack = input.stack.trim();
  const name = input.name.trim();
  if (!stack || !name) throw commandRejected('stack and name are required');
  if (findInstance(ctx, stack, name)) {
    throw commandRejected(`search instance "${name}" already exists in stack "${stack}"`);
  }
  const decl: SearchInstanceDecl = { stack, name, engine: input.engine };
  const node = await resolveManagerNode(ctx);
  const masterKey = generateMasterKey();
  const secretName = searchKeySecretName(stack, name);
  const dataB64 = Buffer.from(masterKey, 'utf8').toString('base64');
  const secretLabels = { [MANAGED_LABEL]: 'true', [SEARCH_CLUSTER_LABEL]: name };

  try {
    await ctx.hub.dispatch(node.id, 'network.ensure', {
      name: searchNetworkName(stack, name),
      driver: 'overlay',
      attachable: true,
      labels: { [MANAGED_LABEL]: 'true', [SEARCH_CLUSTER_LABEL]: name },
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
      { spec: searchInstanceSpec(decl), pullPolicy: 'always' },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: 'search.provision',
    targetType: 'searchInstance',
    targetId: searchBaseName(stack, name),
    metadata: { engine: decl.engine },
  });

  if (input.attachService) {
    // Best-effort: a failed attach must not lose the one-time key reveal —
    // the instance exists and the app can be attached again from the panel.
    await attachSearchToService(ctx, { stack, name, appService: input.attachService }).catch(
      () => undefined,
    );
  }

  const host = searchServiceName(stack, name);
  const port = SEARCH_PORTS[decl.engine];
  return {
    stack,
    name,
    engine: decl.engine,
    host,
    port,
    url: `http://${host}:${port}`,
    keySecret: secretName,
    masterKey,
  };
}

/**
 * Destroy an instance: remove the service + the key secret. Refused while apps
 * are still attached (unless `force`). The data volume and overlay network are
 * left behind on purpose — the volume may hold the last snapshot and both are
 * inert without the service.
 */
export async function destroySearch(
  ctx: OrgContext,
  input: { stack: string; name: string; force?: boolean },
): Promise<{ name: string; removed: true }> {
  const i = requireInstance(ctx, input.stack, input.name);
  const attached = liveOrgServices(ctx).filter(
    (s) => s.stack === i.stack && s.labels[SEARCH_INJECT_LABEL] === i.name,
  );
  if (attached.length > 0 && !input.force) {
    throw commandRejected(
      `${attached.length} service(s) still attached (${attached
        .map((s) => s.name)
        .join(', ')}) — detach them first or pass force`,
    );
  }
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: i.service.name });
  } catch (e) {
    throw mapDispatchError(e);
  }
  // Best-effort: a failed secret removal must not block the destroy.
  await ctx.hub
    .dispatch(node.id, 'secret.remove', { name: searchKeySecretName(i.stack, i.name) })
    .catch(() => undefined);
  await writeAudit(ctx, {
    action: 'search.destroy',
    targetType: 'searchInstance',
    targetId: searchBaseName(input.stack, input.name),
    metadata: { force: Boolean(input.force), service: i.service.name },
  });
  return { name: input.name, removed: true };
}

/**
 * Wire an app service to the instance: attach it to the instance overlay
 * network, mount the key Docker secret, and set the engine's host env vars +
 * `*_KEY_FILE`/`*_MASTER_KEY_FILE` pointing at the secret file. The key itself
 * never leaves Docker (mirrors cache attach; same lossy-merge caveat —
 * mounts/constraints are not exposed by the live inventory and are not
 * re-applied here).
 */
export async function attachSearchToService(
  ctx: OrgContext,
  input: AttachSearchInput,
): Promise<{ appService: string; name: string; envVar: string; url: string; env: Record<string, string> }> {
  const i = requireInstance(ctx, input.stack, input.name);
  const engine = searchEngineOf(i.service.labels);
  const host = i.service.name;
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);

  const secretName = searchKeySecretName(input.stack, input.name);
  const injected = searchAttachEnv(engine, host, secretName);
  const network = searchNetworkName(input.stack, input.name);

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const idx = kv.indexOf('=');
    env[idx >= 0 ? kv.slice(0, idx) : kv] = idx >= 0 ? kv.slice(idx + 1) : '';
  }
  Object.assign(env, injected);

  const secrets = [
    ...(app.secrets ?? []).filter((n) => n !== secretName).map((n) => ({ source: n })),
    { source: secretName },
  ];
  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels: {
      ...app.labels,
      [STACK_LABEL]: input.stack,
      [SEARCH_INJECT_LABEL]: input.name,
      [SEARCH_INJECT_VAR_LABEL]: searchInjectVar(engine),
    },
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: Array.from(new Set([...app.networks.map((n) => n.name), network])),
    secrets,
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'search.attach',
    targetType: 'searchInstance',
    targetId: searchBaseName(input.stack, input.name),
    metadata: { appService: app.name, engine },
  });
  return {
    appService: app.name,
    name: input.name,
    envVar: searchInjectVar(engine),
    url: `http://${host}:${SEARCH_PORTS[engine]}`,
    env: injected,
  };
}

/** Unwire an app: drop the env vars, secret ref, network and inject labels. */
export async function detachSearchFromService(
  ctx: OrgContext,
  input: { stack: string; name: string; appService: string },
): Promise<{ appService: string; name: string; detached: true }> {
  const i = requireInstance(ctx, input.stack, input.name);
  const engine = searchEngineOf(i.service.labels);
  const app = liveOrgServices(ctx).find(
    (s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService),
  );
  if (!app) throw notFound('service', input.appService);
  if (app.labels[SEARCH_INJECT_LABEL] !== input.name) {
    throw commandRejected(`service "${app.name}" is not attached to "${input.name}"`);
  }

  const secretName = searchKeySecretName(input.stack, input.name);
  const network = searchNetworkName(input.stack, input.name);
  const injectedKeys = new Set(Object.keys(searchAttachEnv(engine, i.service.name, secretName)));

  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const idx = kv.indexOf('=');
    const key = idx >= 0 ? kv.slice(0, idx) : kv;
    if (injectedKeys.has(key)) continue;
    env[key] = idx >= 0 ? kv.slice(idx + 1) : '';
  }
  const labels = { ...app.labels };
  delete labels[SEARCH_INJECT_LABEL];
  delete labels[SEARCH_INJECT_VAR_LABEL];

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
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };

  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'search.detach',
    targetType: 'searchInstance',
    targetId: searchBaseName(input.stack, input.name),
    metadata: { appService: app.name },
  });
  return { appService: app.name, name: input.name, detached: true };
}

// ── Stats (live sample via exec; label stamp as fallback) ─────────────────────

/**
 * Live stats sample via the `exec` command (the container holds the master key
 * secret — nothing rides the wire). Falls back to the `swarmy.search.stats`
 * label the reconcile worker stamps.
 */
export async function searchStats(
  ctx: OrgContext,
  input: { stack: string; name: string },
): Promise<SearchStatsView | null> {
  const i = requireInstance(ctx, input.stack, input.name);
  const engine = searchEngineOf(i.service.labels);
  const fallback = parseSearchStatsLabel(i.service.labels[SEARCH_STATS_LABEL]);
  const target = resolveExecTarget(ctx, i.service.name);
  if (!target) return fallback;
  try {
    const res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', searchStatsCommand(engine)],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || !res.output) return fallback;
    const sample = parseSearchStats(engine, res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : fallback;
  } catch {
    return fallback;
  }
}

// ── Backups (engine dump + restic volume snapshot tagged search:<instance>) ───
// Target → repo mirrors backups.service / cache.service (org-scoped rows,
// secrets vault-decrypted just-in-time, never persisted on the node).

interface TargetRow {
  id: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
}

async function resolveTarget(ctx: OrgContext, explicit?: string): Promise<TargetRow> {
  if (explicit) {
    const row = (await ctx.db.backupTarget.findFirst({
      where: { id: explicit, orgId: ctx.activeOrgId },
    })) as unknown as TargetRow | null;
    if (!row) throw notFound('backup target', explicit);
    return row;
  }
  const first = (await ctx.db.backupTarget.findFirst({
    where: { orgId: ctx.activeOrgId, enabled: true },
    orderBy: { createdAt: 'asc' },
  })) as unknown as TargetRow | null;
  if (!first) {
    throw commandRejected('no backup destination configured — add one on the Backups page');
  }
  return first;
}

function toResticRepo(row: TargetRow): ResticRepo {
  const prefix = row.prefix ? `/${row.prefix.replace(/^\/+/, '')}` : '';
  const isNode = row.kind === 'node' || row.kind === 'NODE';
  const repo = isNode
    ? `${row.bucket.replace(/\/+$/, '')}${prefix}`
    : `s3:${(row.endpoint ?? '').replace(/\/+$/, '')}/${row.bucket}${prefix}`;
  return {
    kind: isNode ? 'node' : 's3',
    repo,
    password: decryptSecret(row.resticPasswordRef),
    endpoint: row.endpoint ?? undefined,
    region: row.region ?? undefined,
    accessKeyId: row.credentialRef ? decryptSecret(row.credentialRef) : undefined,
    secretAccessKey: row.secretKeyRef ? decryptSecret(row.secretKeyRef) : undefined,
  };
}

/** Best-effort meilisearch dump before the volume snapshot (typesense: no-op). */
async function dumpBeforeBackup(ctx: OrgContext, i: LiveInstance): Promise<void> {
  if (searchEngineOf(i.service.labels) !== 'meilisearch') return;
  const target = resolveExecTarget(ctx, i.service.name);
  if (!target) return;
  await ctx.hub
    .dispatch(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', meiliDumpCommand()],
        tty: false,
        stream: false,
      },
      { timeoutMs: (DUMP_WAIT_SECONDS + 15) * 1000 },
    )
    .catch(() => undefined);
}

/** Snapshot the instance's data volume (engine dump → restic backup.run). */
export async function backupSearch(
  ctx: OrgContext,
  input: { stack: string; name: string; targetId?: string },
): Promise<{ resticId: string; sizeBytes: string }> {
  const i = requireInstance(ctx, input.stack, input.name);
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  const volume = searchDataVolume(input.stack, input.name);
  await dumpBeforeBackup(ctx, i);
  try {
    const result = await ctx.hub.dispatch<BackupVolumeResult>(
      node.id,
      'backup.run',
      {
        jobId: `search-${searchBaseName(input.stack, input.name)}-${Date.now()}`,
        repo: toResticRepo(target),
        volume,
        tags: [
          `org:${ctx.activeOrgId}`,
          `volume:${volume}`,
          searchBackupTag(input.stack, input.name),
        ],
      },
      { timeoutMs: BACKUP_TIMEOUT_MS },
    );
    await writeAudit(ctx, {
      action: 'search.backup',
      targetType: 'searchInstance',
      targetId: searchBaseName(input.stack, input.name),
      metadata: { targetId: target.id, resticId: result.snapshotId, volume },
    });
    return { resticId: result.snapshotId, sizeBytes: String(result.sizeBytes) };
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/**
 * Restore a snapshot into the instance's data volume: stop the engine (scale
 * 0, with a `swarmy.search.restoring` marker so the reconcile doesn't wake it
 * mid-restore), `backup.restore`, then start it again — the engine reloads the
 * restored data dir. The instance is restarted even when the restore fails
 * (old data intact).
 */
export async function restoreSearch(
  ctx: OrgContext,
  input: { stack: string; name: string; snapshotId: string; targetId?: string },
): Promise<{ name: string; bytesRestored: string }> {
  const i = requireInstance(ctx, input.stack, input.name);
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  const volume = searchDataVolume(input.stack, input.name);
  const serviceName = i.service.name;

  await ctx.hub.dispatch(node.id, 'service.updateLabels', {
    service: serviceName,
    add: { [SEARCH_RESTORING_LABEL]: 'true' },
    removeKeys: [],
  });
  await ctx.hub.dispatch(node.id, 'service.scale', { service: serviceName, replicas: 0 });
  let result: RestoreVolumeResult;
  try {
    result = await ctx.hub.dispatch<RestoreVolumeResult>(
      node.id,
      'backup.restore',
      { repo: toResticRepo(target), snapshotId: input.snapshotId, targetVolume: volume },
      { timeoutMs: BACKUP_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  } finally {
    await ctx.hub
      .dispatch(node.id, 'service.scale', { service: serviceName, replicas: 1 })
      .catch(() => undefined);
    await ctx.hub
      .dispatch(node.id, 'service.updateLabels', {
        service: serviceName,
        add: {},
        removeKeys: [SEARCH_RESTORING_LABEL],
      })
      .catch(() => undefined);
  }
  await writeAudit(ctx, {
    action: 'search.restore',
    targetType: 'searchInstance',
    targetId: searchBaseName(input.stack, input.name),
    metadata: { snapshotId: input.snapshotId, bytesRestored: result.bytesRestored },
  });
  return { name: input.name, bytesRestored: String(result.bytesRestored) };
}

/** Snapshots for this instance (restic catalog filtered by the search tag). */
export async function listSearchBackups(
  ctx: OrgContext,
  input: { stack: string; name: string; targetId?: string },
): Promise<SearchBackupView[]> {
  const target = await resolveTarget(ctx, input.targetId);
  const node = await resolveManagerNode(ctx);
  try {
    const res = await ctx.hub.dispatch<ListSnapshotsResult>(node.id, 'backup.list', {
      repo: toResticRepo(target),
      tags: [searchBackupTag(input.stack, input.name)],
    });
    return res.snapshots
      .map((s) => ({
        id: s.id,
        time: s.time,
        sizeBytes: s.sizeBytes != null ? String(s.sizeBytes) : null,
        tags: s.tags,
      }))
      .sort((a, b) => b.time.localeCompare(a.time));
  } catch (e) {
    throw mapDispatchError(e);
  }
}
