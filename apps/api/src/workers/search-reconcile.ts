import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import { STACK_LABEL } from '@swarmy/core';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Managed-search reconcile worker (slice F4).
 *
 * Every ~30s, for each org, read the managed search instances off the LIVE
 * inventory (services carrying `swarmy.search.engine` + `swarmy.search.cluster`)
 * and:
 *   1. CONVERGE — an instance parked at 0 replicas is woken back to 1, unless a
 *      restore is in flight (`swarmy.search.restoring` marker) — single-node v1
 *      has no other structural drift to converge.
 *   2. STATS — sample docs/indexes inside the container (exec; the master key
 *      stays in the container's secret file) and stamp the result as the
 *      `swarmy.search.stats` label so views render without a live exec.
 *   3. ALERT — fire `search-instance-down` when the engine has 0/N running.
 *
 * Pure Docker-truth: reads the hub snapshot, dispatches to the org's manager,
 * no DB rows. The label scheme, commands and parsers mirror `@swarmy/trpc`
 * search.service.ts (the unit-tested canonical copies) — a worker cannot
 * subpath-import an internal trpc module, same constraint the manageddb/cache
 * reconcile workers document.
 */

const TICK_MS = 30_000;

// ── Label scheme — kept in sync with @swarmy/trpc search.service.ts ───────────
const SEARCH_ENGINE_LABEL = 'swarmy.search.engine';
const SEARCH_CLUSTER_LABEL = 'swarmy.search.cluster';
const SEARCH_STATS_LABEL = 'swarmy.search.stats';
const SEARCH_RESTORING_LABEL = 'swarmy.search.restoring';
const SEARCH_INJECT_LABEL = 'swarmy.search.inject';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const SECRET_TARGET = 'search-master-key';

type SearchEngine = 'meilisearch' | 'typesense';
const PORTS: Record<SearchEngine, number> = { meilisearch: 7700, typesense: 8108 };

interface Instance {
  stack: string;
  name: string;
  engine: SearchEngine;
  service: SwarmServiceInfo;
}

// ── Stats sampling — mirror of search.service.ts (unit-tested canonical copy) ─

interface StatsSample {
  docs: number;
  indexes: number;
  dbSizeBytes: number | null;
  memoryBytes: number | null;
  at: string;
}

function parseMeiliStats(raw: string): Omit<StatsSample, 'at'> | null {
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

function parseTypesenseStats(raw: string): Omit<StatsSample, 'at'> | null {
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

/** In-container stats command (curl → wget → bash /dev/tcp fallbacks). */
function statsCommand(engine: SearchEngine): string {
  // Exported so the `bash -c` /dev/tcp fallback (a subprocess) sees it too.
  const key = `export KEY="$(cat /run/secrets/${SECRET_TARGET})"`;
  if (engine === 'meilisearch') {
    const url = `http://localhost:${PORTS.meilisearch}/stats`;
    return (
      `${key}; curl -fsS -H "Authorization: Bearer $KEY" ${url} 2>/dev/null` +
      ` || wget -qO- --header="Authorization: Bearer $KEY" ${url}`
    );
  }
  const port = PORTS.typesense;
  const get = (path: string): string =>
    `(curl -fsS -H "X-TYPESENSE-API-KEY: $KEY" http://localhost:${port}${path} 2>/dev/null` +
    ` || bash -c 'exec 3<>/dev/tcp/localhost/${port};` +
    ` printf "GET ${path} HTTP/1.0\\r\\nX-TYPESENSE-API-KEY: %s\\r\\n\\r\\n" "$KEY" >&3;` +
    ` sed "1,/^\\r\\{0,1\\}$/d" <&3')`;
  return `${key}; ${get('/collections')}; echo; ${get('/metrics.json')}`;
}

/** Find a running container for the service + the node hosting it. */
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

async function sampleStats(orgId: string, inst: Instance): Promise<StatsSample | null> {
  if ((inst.service.runningReplicas ?? 0) < 1) return null;
  const target = execTarget(orgId, inst.service);
  if (!target) return null;
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', statsCommand(inst.engine)],
        tty: false,
        stream: false,
      },
      { timeoutMs: 20_000 },
    );
    if (res.exitCode !== 0 || !res.output) return null;
    const sample =
      inst.engine === 'meilisearch'
        ? parseMeiliStats(res.output)
        : parseTypesenseStats(res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

// ── Reconcile ─────────────────────────────────────────────────────────────────

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  const instances: Instance[] = [];
  for (const s of services) {
    const name = s.labels[SEARCH_CLUSTER_LABEL];
    // Instance anchors carry engine+cluster; attached apps only carry inject labels.
    if (!name || !s.labels[SEARCH_ENGINE_LABEL] || s.labels[SEARCH_INJECT_LABEL]) continue;
    instances.push({
      stack: s.labels[STACK_LABEL] ?? '',
      name,
      engine: s.labels[SEARCH_ENGINE_LABEL] === 'typesense' ? 'typesense' : 'meilisearch',
      service: s,
    });
  }
  if (instances.length === 0) return;

  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);

  for (const inst of instances) {
    const s = inst.service;
    const base = `${inst.stack}_${inst.name}`;
    const restoring = s.labels[SEARCH_RESTORING_LABEL] === 'true';

    // (1) Converge: a single-node instance parked at 0 (and not mid-restore)
    //     is woken back to its one replica.
    if ((s.desiredReplicas ?? 0) === 0 && !restoring) {
      await hub
        .dispatch(node, 'service.scale', { service: s.name, replicas: 1 })
        .catch(() => undefined);
      continue; // nothing to sample until it's back
    }

    // (2) Down alert: desired > 0 but nothing running (skip mid-restore).
    if ((s.desiredReplicas ?? 0) > 0 && (s.runningReplicas ?? 0) < 1) {
      if (!restoring) {
        await fireEvent(ctx, {
          signal: 'search-instance-down',
          severity: 'critical',
          resource: base,
          message: `Search ${inst.stack}/${inst.name} (${inst.engine}): instance is down (0/${s.desiredReplicas ?? 1} running)`,
        }).catch(() => undefined);
      }
      continue;
    }

    // (3) Stats stamp for the views (cheap read without a live exec).
    const stats = await sampleStats(orgId, inst);
    if (stats) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: s.name,
          add: { [SEARCH_STATS_LABEL]: JSON.stringify(stats) },
          removeKeys: [],
        })
        .catch(() => undefined);
    }
  }
}

export function startSearchReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
