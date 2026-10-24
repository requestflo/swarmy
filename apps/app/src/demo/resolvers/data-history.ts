import {
  autoscaleStep,
  dataHistorySlots,
  desiredWorkers,
  dataHistoryStepSeconds,
  type BucketSizeHistoryView,
  type CacheClusterView,
  type CacheStatsHistoryView,
  type QueueCalm,
  type QueueDepthHistoryView,
  type QueueView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { STOREFRONT_QUEUES } from './queue-studio-demo';

/**
 * Managed data history demo (`cache.statsHistory`, `queues.depthHistory`,
 * `buckets.sizeHistory`), each anchored on the numbers the same screen shows
 * live: a cache's hit rate dips overnight and lands on today's reading; a
 * queue's backlog had a burst a couple of hours ago that its workers scaled
 * up to absorb (one copy per `scalePerJobs` waiting, up to `maxWorkers`, and
 * back down only after the cooldown — the real `autoscaleStep`) and ends on
 * today's depth; a bucket grew ~1.7% over the week (storefront-
 * media: +310 MB) up to its size now. An empty bucket has no history yet.
 */

const HOUR = 3_600_000;

/** Deterministic noise in [0, 1) per key and slot. */
function unit(key: string, i: number): number {
  let h = 0x811c9dc5 ^ i;
  for (let c = 0; c < key.length; c++) h = Math.imul(h ^ key.charCodeAt(c), 0x01000193);
  return (h >>> 0) / 0x1_0000_0000;
}

/** The grid the controller would return for `hours` ending now. */
function grid(hours: number): { from: number; step: number; slots: number; at: (i: number) => number } {
  const step = dataHistoryStepSeconds(hours);
  const slots = dataHistorySlots(hours);
  const from = (Math.floor(Date.now() / 1000 / step) - slots + 1) * step * 1000;
  return { from, step, slots, at: (i) => from + i * step * 1000 };
}

const hoursOf = (i: unknown, fallback: number): number => Number((i as { hours?: number } | undefined)?.hours ?? fallback);
/** 0 at 04:00 UTC → 1 mid-afternoon. */
const busy = (t: number): number => 0.5 + 0.5 * Math.sin(((new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60 - 10) / 24) * 2 * Math.PI);

function cacheHistory(input: unknown, s: DemoStore): CacheStatsHistoryView {
  const { stack, cluster } = input as { stack: string; cluster: string };
  const c = (s.extra.cache as { clusters: CacheClusterView[] } | undefined)?.clusters.find((x) => x.stack === stack && x.name === cluster);
  const g = grid(hoursOf(input, 24));
  const hit = c?.stats?.hitRatePct ?? 95;
  const ops = c?.stats?.opsPerSec ?? 200;
  const mem = c?.stats?.usedMemoryBytes ?? (c?.memoryMb ?? 256) * 1024 * 1024 * 0.4;
  const hitRatePct: number[] = [];
  const lookups: number[] = [];
  const opsPerSec: number[] = [];
  const usedMemoryBytes: number[] = [];
  for (let i = 0; i < g.slots; i++) {
    const t = g.at(i);
    const last = i === g.slots - 1;
    // Quiet nights miss more (cold keys); the slot holding now is today's reading.
    hitRatePct.push(last ? hit : Math.round(Math.min(99.5, hit - 4 * (1 - busy(t)) + 1.5 * (unit(`${cluster}:hit`, i) - 0.5)) * 10) / 10);
    const o = Math.round(last ? ops : ops * (0.35 + 0.75 * busy(t)) * (0.9 + 0.2 * unit(`${cluster}:ops`, i)));
    opsPerSec.push(o);
    lookups.push(Math.round(o * g.step * 0.6));
    usedMemoryBytes.push(Math.round(mem * (0.92 + 0.08 * (i / g.slots))));
  }
  return { from: new Date(g.from).toISOString(), stepSeconds: g.step, hitRatePct, lookups, opsPerSec, usedMemoryBytes };
}

function queueHistory(input: unknown, s: DemoStore): QueueDepthHistoryView {
  const { stack, cluster, queue } = input as { stack: string; cluster: string; queue: string };
  const def = (s.extra.queues as { queues: QueueView[] } | undefined)?.queues.find(
    (q) => q.cacheStack === stack && q.cacheName === cluster && q.name === queue && q.convention === 'bullmq',
  );
  const q = STOREFRONT_QUEUES.find((x) => x.name === queue);
  const g = grid(hoursOf(input, 6));
  const blank = (): Array<number | null> => new Array<number | null>(g.slots).fill(null);
  const view = { from: new Date(g.from).toISOString(), stepSeconds: g.step, waiting: blank(), active: blank(), workers: blank(), completed: blank(), failed: blank() };
  if (!q || stack !== 'storefront' || cluster !== 'main') return view;
  const per = Math.max(1, def?.scalePerJobs ?? 100);
  const max = Math.max(1, def?.maxWorkers ?? 1);
  const rule = { scalePerJobs: per, minWorkers: 1, maxWorkers: max };
  let copies = Math.max(1, def?.workers.running ?? 1);
  let calm: QueueCalm | null = null;
  for (let i = 0; i < g.slots; i++) {
    const hoursAgo = (Date.now() - g.at(i)) / HOUR;
    // A burst ~2 h ago (sale traffic), draining over the next hour; today's depth now.
    const burst = Math.max(0, 1 - Math.abs(hoursAgo - 2) / 0.9);
    const base = q.wait * (0.6 + 0.5 * unit(`${queue}:w`, i));
    const waiting = i === g.slots - 1 ? q.wait : Math.round(base + burst * Math.max(400, q.wait * 2.5));
    view.waiting[i] = waiting;
    view.active[i] = Math.min(copies * 4, q.active + Math.round(burst * 6));
    view.workers[i] = copies;
    // The autoscaler follows the depth one sample later: up at once, down after the calm.
    const now = g.at(i);
    const step = autoscaleStep({ current: copies, target: desiredWorkers(rule, waiting), cooldownSeconds: def?.cooldownSeconds ?? 600, calm, lastSampleAt: now, now });
    copies = step.replicas;
    calm = step.calm;
    const done = (q.perMin * g.step) / 60;
    view.completed[i] = Math.round(done * (0.5 + 0.6 * busy(g.at(i))) * (1 + burst));
    view.failed[i] = q.failed && unit(`${queue}:f`, i) > 0.85 ? 1 + Math.round(2 * unit(`${queue}:n`, i)) : 0;
  }
  if (def) view.workers[g.slots - 1] = def.workers.running;
  return view;
}

function bucketHistory(input: unknown, s: DemoStore): BucketSizeHistoryView {
  const { bucketId } = input as { bucketId: string };
  const b = (s.extra.buckets as { buckets: Array<{ id: string; usageBytes: number; objects: number }> } | undefined)?.buckets.find((x) => x.id === bucketId);
  const g = grid(hoursOf(input, 168));
  const bytes = new Array<number | null>(g.slots).fill(null);
  const objects = new Array<number | null>(g.slots).fill(null);
  if (b && b.usageBytes > 0) {
    // ~310 MB a week on 18.4 GB: uploads by day, flat nights.
    const weekly = b.usageBytes * 0.01645;
    for (let i = 0; i < g.slots; i++) {
      const left = (g.slots - 1 - i) / (g.slots - 1);
      const wobble = i === g.slots - 1 ? 0 : 0.004 * weekly * (unit(`${bucketId}:b`, i) - 0.5);
      bytes[i] = Math.round(b.usageBytes - weekly * left + wobble);
      objects[i] = Math.round(b.objects * (1 - 0.0165 * left));
    }
  }
  return { from: new Date(g.from).toISOString(), stepSeconds: g.step, bytes, objects };
}

export const dataHistory: DomainResolvers = {
  handlers: {
    'cache.statsHistory': cacheHistory,
    'queues.depthHistory': queueHistory,
    'buckets.sizeHistory': bucketHistory,
  },
};
