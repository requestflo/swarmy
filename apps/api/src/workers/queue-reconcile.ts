import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { QUEUES_CALM_LABEL, type QueueDef, type QueueDepthSample } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  fireEvent,
  parseQueueStatsLabel,
  parseQueuesLabel,
  QUEUES_LABEL,
  QUEUES_STATS_LABEL,
  systemContext,
  type OrgContext,
} from '@swarmy/trpc';
import { hub, store } from '../gateway';
import { planWorkerTick, type WorkerMemo } from './queue-reconcile.core';
import { sampleBull, sampleQueue, STACK_LABEL, type BullSampled } from './queue-reconcile.live';

/**
 * Queue reconcile worker (slice B1). Every ~15s, per org:
 *   0. sample every queue's depth (queue-reconcile.live.ts: the queue-studio
 *      sampler for BullMQ, which also feeds `queues.depthHistory`; one
 *      `redis-cli EVAL` exec for a raw list),
 * then for each WORKER service carrying `swarmy.queues` defs:
 *   1. stamp the samples into `swarmy.queues.stats` and the scale-down
 *      cooldown clock into `swarmy.queues.calm` (one label write),
 *   2. scale it: up at once to clamp(ceil(wait/scalePerJobs), min, max) — the
 *      max across its queues — and down only after `cooldownSeconds` of calm
 *      (`autoscaleStep`, @swarmy/core queue-autoscale.ts), behind a signature
 *      gate so a steady tick sends nothing (queue-reconcile.core.ts),
 *   3. fire alert events when failed jobs pile up or the backlog keeps growing
 *      beyond what maxWorkers can absorb.
 *
 * Pure Docker-truth: hub snapshot in, dispatches out, no DB rows. The label
 * codecs and depth probe are the queues view's own, from the @swarmy/trpc root.
 */

const TICK_MS = 15_000;
/** Failed jobs at/above this fire a `queue-failed-jobs` warning. */
const FAILED_ALERT_THRESHOLD = 10;

/** `<orgId>|<worker service>` → this process's calm clock + last push. */
const memos = new Map<string, WorkerMemo>();
const running = new Set<string>();

async function alertOn(ctx: OrgContext, worker: string, def: QueueDef, s: QueueDepthSample, prev?: QueueDepthSample): Promise<void> {
  const resource = `${worker}/${def.name}`;
  if (s.failed >= FAILED_ALERT_THRESHOLD) {
    await fireEvent(ctx, {
      signal: 'queue-failed-jobs',
      severity: 'warning',
      resource,
      message: `Queue ${def.name}: ${s.failed} failed jobs on ${worker} — retry or inspect the DLQ`,
    }).catch(() => undefined);
  }
  if (prev && s.wait > prev.wait && s.wait > def.scalePerJobs * def.maxWorkers) {
    await fireEvent(ctx, {
      signal: 'queue-backlog',
      severity: 'warning',
      resource,
      message: `Queue ${def.name}: backlog ${s.wait} and growing — beyond ${def.maxWorkers} workers × ${def.scalePerJobs} jobs`,
    }).catch(() => undefined);
  }
}

async function reconcileWorker(
  orgId: string,
  node: string,
  ctx: OrgContext,
  services: SwarmServiceInfo[],
  worker: SwarmServiceInfo,
  bull: BullSampled,
): Promise<void> {
  const defs = parseQueuesLabel(worker.labels[QUEUES_LABEL]);
  if (defs.length === 0) return;
  const stack = worker.labels[STACK_LABEL] ?? '';
  const prevStats = parseQueueStatsLabel(worker.labels[QUEUES_STATS_LABEL]);
  const fresh = new Map<string, QueueDepthSample>();
  for (const def of defs) {
    const sample = await sampleQueue(orgId, services, stack, def, bull);
    if (!sample) continue;
    fresh.set(def.name, sample);
    await alertOn(ctx, worker.name, def, sample, prevStats[def.name]);
  }

  const key = `${orgId}|${worker.name}`;
  const now = Date.now();
  const plan = planWorkerTick(
    {
      defs,
      fresh,
      prevStats,
      liveStats: worker.labels[QUEUES_STATS_LABEL],
      liveCalm: worker.labels[QUEUES_CALM_LABEL],
      current: worker.desiredReplicas ?? 0,
      scalable: worker.mode !== 'global',
      now,
    },
    memos.get(key),
  );
  if (plan.memo) memos.set(key, plan.memo);

  // (1) Stats stamp + calm clock, one label write (only when one changes).
  const add: Record<string, string> = {};
  const removeKeys: string[] = [];
  if (plan.stats) add[QUEUES_STATS_LABEL] = plan.stats;
  if (typeof plan.calm === 'string') add[QUEUES_CALM_LABEL] = plan.calm;
  else if (plan.calm === null) removeKeys.push(QUEUES_CALM_LABEL);
  if (Object.keys(add).length > 0 || removeKeys.length > 0) {
    await hub.dispatch(node, 'service.updateLabels', { service: worker.name, add, removeKeys }).catch(() => undefined);
  }

  // (2) Scale — only off a live sample, and only when the gate says it's due.
  if (plan.scale !== null && plan.memo) {
    const replicas = plan.scale;
    const ok = await hub.dispatch(node, 'service.scale', { service: worker.name, replicas }).then(
      () => true,
      () => false,
    );
    if (ok) memos.set(key, { ...plan.memo, pushed: { replicas, at: now } });
  }
}

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;
  const { services } = hub.liveInventory(orgId);
  const workers = services.filter((s) => Boolean(s.labels[QUEUES_LABEL]));
  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
  const bull = await sampleBull(ctx, workers);
  const seen = new Set<string>();
  for (const worker of workers) {
    seen.add(`${orgId}|${worker.name}`);
    await reconcileWorker(orgId, node, ctx, services, worker, bull).catch(() => undefined);
  }
  for (const k of memos.keys()) if (k.startsWith(`${orgId}|`) && !seen.has(k)) memos.delete(k);
}

export function startQueueReconcile(): () => void {
  const timer = setInterval(() => {
    for (const orgId of new Set(store.nodeOrg.values())) {
      if (running.has(orgId)) continue; // a slow tick never overlaps the next
      running.add(orgId);
      void reconcileOrg(orgId)
        .catch(() => undefined)
        .finally(() => running.delete(orgId));
    }
  }, TICK_MS);
  return () => clearInterval(timer);
}
