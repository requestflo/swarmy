import {
  depthCommand,
  parseCacheClusterRef,
  parseDepthOutput,
  parseQueuesLabel,
  QUEUES_LABEL,
  recordQueueHistory,
  sampleQueueClusters,
  type OrgContext,
} from '@swarmy/trpc';
import type { QueueDef, QueueDepthSample } from '@swarmy/core';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';

/**
 * Live plumbing for queue-reconcile: the depth of every queue a worker
 * consumes. BullMQ queues come from the queue-studio sampler
 * (`sampleQueueClusters`: counts by state, backlog = wait + prioritized, 0
 * while paused — the numbers the studio shows), which also feeds the history
 * (`recordQueueHistory`). A raw-list queue is one `redis-cli EVAL` exec on
 * its cache PRIMARY (the password stays in the container's secret file).
 */

const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
export const STACK_LABEL = 'com.docker.stack.namespace';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const EXEC_TIMEOUT_MS = 20_000;

export function findCachePrimary(
  services: SwarmServiceInfo[],
  workerStack: string,
  cacheCluster: string,
): SwarmServiceInfo | undefined {
  const ref = parseCacheClusterRef(cacheCluster, workerStack);
  return services.find(
    (s) =>
      s.labels[CACHE_ROLE_LABEL] === 'primary' &&
      s.labels[CACHE_CLUSTER_LABEL] === ref.cluster &&
      (s.labels[STACK_LABEL] ?? '') === ref.stack,
  );
}

/** Find a running container for the service + the node hosting it. */
function execTarget(orgId: string, service: SwarmServiceInfo): { nodeId: string; containerId: string } | undefined {
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

/** One raw-list queue's depth off its cache primary; null when it can't be read. */
export async function sampleListDepth(
  orgId: string,
  primary: SwarmServiceInfo,
  def: QueueDef,
): Promise<QueueDepthSample | null> {
  const target = execTarget(orgId, primary);
  if (!target) return null;
  const engine = primary.labels[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey';
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['sh', '-c', depthCommand(engine, def)],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0 || res.output == null) return null;
    const sample = parseDepthOutput(res.output, def.convention);
    return sample ? { ...sample, ts: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

export interface BullSampled {
  /** `<stack>/<cluster>/<queue>` → sample. */
  counts: Map<string, QueueDepthSample>;
  /** `<stack>/<cluster>` of every cache that answered. */
  clusters: Set<string>;
  at: string;
}

/** (0) BullMQ counts for every queue cache and every cache a BullMQ def points at. */
export async function sampleBull(ctx: OrgContext, workers: SwarmServiceInfo[]): Promise<BullSampled> {
  const extras = new Map<string, { stack: string; cluster: string; queues: string[] }>();
  for (const w of workers) {
    for (const def of parseQueuesLabel(w.labels[QUEUES_LABEL])) {
      if (def.convention !== 'bullmq') continue;
      const ref = parseCacheClusterRef(def.cacheCluster, w.labels[STACK_LABEL] ?? '');
      const k = `${ref.stack}/${ref.cluster}`;
      const e = extras.get(k) ?? { stack: ref.stack, cluster: ref.cluster, queues: [] };
      e.queues.push(def.name);
      extras.set(k, e);
    }
  }
  const sampled = await sampleQueueClusters(ctx, [...extras.values()]).catch(() => []);
  // History: fold this tick into each queue's 5-minute bucket; ended buckets land in telemetry.db.
  await recordQueueHistory(ctx, sampled).catch(() => undefined);
  const at = new Date().toISOString();
  const counts = new Map<string, QueueDepthSample>();
  for (const c of sampled) {
    for (const q of c.queues) {
      counts.set(`${c.stack}/${c.cluster}/${q.name}`, {
        wait: q.isPaused ? 0 : q.counts.wait + q.counts.prioritized,
        active: q.counts.active,
        failed: q.counts.failed,
        delayed: q.counts.delayed,
        ts: at,
      });
    }
  }
  return { counts, clusters: new Set(sampled.map((c) => `${c.stack}/${c.cluster}`)), at };
}

/** One queue's depth this tick, or null when nothing could be read. */
export async function sampleQueue(
  orgId: string,
  services: SwarmServiceInfo[],
  workerStack: string,
  def: QueueDef,
  bull: BullSampled,
): Promise<QueueDepthSample | null> {
  const primary = findCachePrimary(services, workerStack, def.cacheCluster);
  if (def.convention !== 'bullmq') return primary ? sampleListDepth(orgId, primary, def) : null;
  const ref = parseCacheClusterRef(def.cacheCluster, workerStack);
  const k = `${ref.stack}/${ref.cluster}`;
  const hit = bull.counts.get(`${k}/${def.name}`);
  if (hit) return hit;
  // The cache answered but the queue has no keys yet: an empty queue.
  return primary && bull.clusters.has(k) ? { wait: 0, active: 0, failed: 0, delayed: 0, ts: bull.at } : null;
}
