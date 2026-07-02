import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Vector-store reconcile worker (slice F5 ai).
 *
 * Every ~30s, for each org, read the managed qdrant instances off the LIVE
 * inventory (services carrying `swarmy.vector.kind=qdrant`) and:
 *
 *   (1) converge: instances are always single-replica — scale any drifted
 *       desired count back to 1 (they must never sleep or fan out; qdrant
 *       clustering is out of scope for the minimal mirror).
 *   (2) sample: exec `curl :6333/collections` inside the running container
 *       (the API key stays inside the container's secret file) and stamp the
 *       result as the `swarmy.vector.stats` label — the UI's fallback when a
 *       live exec is not possible.
 *   (3) alert: fire a `vector-down` event when an instance has 0/1 running.
 *
 * pgvector needs no reconcile — it is a one-shot `CREATE EXTENSION` + label.
 *
 * Pure Docker-truth: reads the hub snapshot, dispatches to the org's manager,
 * no DB rows. Label constants + the stats command mirror `@swarmy/trpc`
 * vector.service.ts (the unit-tested canonical copies) — a worker cannot
 * subpath-import an internal trpc module, same constraint the cache/manageddb
 * reconcile workers document.
 */

const TICK_MS = 30_000;

// ── Label scheme — kept in sync with @swarmy/trpc vector.service.ts ───────────
const VECTOR_KIND_LABEL = 'swarmy.vector.kind';
const VECTOR_NAME_LABEL = 'swarmy.vector.name';
const VECTOR_STATS_LABEL = 'swarmy.vector.stats';
const STACK_LABEL = 'com.docker.stack.namespace';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

const VECTOR_PORT = 6333;
const SECRET_TARGET = 'vector-api-key';
const EXEC_TIMEOUT_MS = 20_000;

interface StatsSample {
  collections: number;
  collectionNames: string[];
  at: string;
}

/** Mirror of vector.service.ts `parseQdrantCollections` (tested canonical copy). */
function parseCollections(raw: string): Omit<StatsSample, 'at'> | null {
  try {
    const json = JSON.parse(raw) as { result?: { collections?: Array<{ name?: unknown }> } };
    const list = json.result?.collections;
    if (!Array.isArray(list)) return null;
    const names = list
      .map((c) => (typeof c?.name === 'string' ? c.name : null))
      .filter((n): n is string => n !== null)
      .sort((a, b) => a.localeCompare(b));
    return { collections: names.length, collectionNames: names.slice(0, 25) };
  } catch {
    return null;
  }
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

async function sampleStats(orgId: string, service: SwarmServiceInfo): Promise<StatsSample | null> {
  const target = execTarget(orgId, service);
  if (!target) return null;
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: [
          'sh',
          '-c',
          `curl -sf -H "api-key: $(cat /run/secrets/${SECRET_TARGET})" http://127.0.0.1:${VECTOR_PORT}/collections`,
        ],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || !res.output) return null;
    const sample = parseCollections(res.output);
    return sample ? { ...sample, at: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);
  const instances = services.filter((s) => s.labels[VECTOR_KIND_LABEL] === 'qdrant');
  if (instances.length === 0) return;

  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);

  for (const s of instances) {
    const stack = s.labels[STACK_LABEL] ?? '';
    const name = s.labels[VECTOR_NAME_LABEL] ?? s.name;

    // (1) Converge: qdrant instances are always exactly one replica.
    if ((s.desiredReplicas ?? 1) !== 1) {
      await hub.dispatch(node, 'service.scale', { service: s.name, replicas: 1 }).catch(() => undefined);
    }

    // (3) Alert on a down instance (0 running).
    if ((s.runningReplicas ?? 0) < 1) {
      await fireEvent(ctx, {
        signal: 'vector-down',
        severity: 'warning',
        resource: `${stack}_${name}`,
        message: `Vector store ${stack}/${name}: qdrant is down (0/1 running)`,
      }).catch(() => undefined);
      continue;
    }

    // (2) Stats stamp (cheap history the UI falls back to).
    const stats = await sampleStats(orgId, s);
    if (stats) {
      await hub
        .dispatch(node, 'service.updateLabels', {
          service: s.name,
          add: { [VECTOR_STATS_LABEL]: JSON.stringify(stats) },
          removeKeys: [],
        })
        .catch(() => undefined);
    }
  }
}

export function startVectorReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
