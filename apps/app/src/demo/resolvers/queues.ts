import type {
  QueueDepthSample,
  QueueDlqItemView,
  QueueDrainResult,
  QueueRequeueResult,
  QueueRetryResult,
  QueueView,
  QueuesOverview,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Queues demo resolvers — the Queues surface (`/queues`): queue list, live-ish
 * depth stats, attach/update/remove, retry/drain and the DLQ browser. Return
 * shapes mirror `queues.service.ts` views exactly (imported from @swarmy/core,
 * never redeclared). State lives in `store.extra.queues`; mutations rewrite it
 * so the page reflects changes after invalidation.
 */

interface QueuesState {
  queues: QueueView[];
  /** `<workerService>/<queue>` → dead-letter payloads (oldest first). */
  dlq: Record<string, string[]>;
}

const key = (q: Pick<QueueView, 'workerService' | 'name'>): string =>
  `${q.workerService}/${q.name}`;
const nowIso = (): string => new Date().toISOString();

function getState(store: DemoStore): QueuesState {
  return store.extra.queues as QueuesState;
}

function require_(st: QueuesState, i: unknown): QueueView {
  const { workerService, queue } = i as { workerService: string; queue: string };
  const q = st.queues.find((x) => x.workerService === workerService && x.name === queue);
  if (!q) throw new Error('queue not found');
  return q;
}

const clamp = (def: QueueView, wait: number): number =>
  Math.min(
    def.maxWorkers,
    Math.max(def.minWorkers, Math.ceil(Math.max(0, wait) / Math.max(1, def.scalePerJobs))),
  );

/** Wobble a queue's depths so polls feel alive, and keep workers tracking wait. */
function liveSample(q: QueueView): QueueDepthSample {
  const base = q.stats ?? { wait: 0, active: 0, failed: 0, delayed: 0, ts: nowIso() };
  const wob = (n: number, pct: number): number =>
    Math.max(0, Math.round(n * (1 + (Math.random() * 2 - 1) * pct)));
  const next: QueueDepthSample = {
    wait: wob(base.wait, 0.15),
    active: Math.min(q.workers.running * 2, wob(Math.max(base.active, 1), 0.4)),
    failed: base.failed,
    delayed: wob(base.delayed, 0.2),
    ts: nowIso(),
  };
  q.stats = next;
  const target = clamp(q, next.wait);
  q.workers = { desired: target, running: target };
  return next;
}

function makeQueue(input: Partial<QueueView> & Pick<QueueView, 'name' | 'workerService'>): QueueView {
  const stack = input.stack ?? 'storefront';
  return {
    name: input.name,
    cacheCluster: input.cacheCluster ?? 'main',
    convention: input.convention ?? 'bullmq',
    ...(input.listKey ? { listKey: input.listKey } : {}),
    scalePerJobs: input.scalePerJobs ?? 100,
    minWorkers: input.minWorkers ?? 1,
    maxWorkers: input.maxWorkers ?? 5,
    retries: input.retries ?? 3,
    dlq: input.dlq ?? true,
    workerService: input.workerService,
    stack,
    cacheStack: input.cacheStack ?? stack,
    cacheName: input.cacheName ?? 'main',
    cacheOnline: input.cacheOnline ?? true,
    workers: input.workers ?? { desired: 1, running: 1 },
    stats: input.stats ?? null,
  };
}

export const queues: DomainResolvers = {
  seed: (store) => {
    // Three queues on the seeded cache clusters — one with a failure pile-up.
    const emails = makeQueue({
      name: 'emails',
      workerService: 'storefront_email-worker',
      stack: 'storefront',
      cacheCluster: 'main',
      cacheStack: 'storefront',
      cacheName: 'main',
      scalePerJobs: 25,
      minWorkers: 1,
      maxWorkers: 4,
      retries: 5,
      workers: { desired: 2, running: 2 },
      stats: { wait: 38, active: 4, failed: 0, delayed: 12, ts: nowIso() },
    });
    const resize = makeQueue({
      name: 'image-resize',
      workerService: 'storefront_media-worker',
      stack: 'storefront',
      cacheCluster: 'main',
      cacheStack: 'storefront',
      cacheName: 'main',
      scalePerJobs: 50,
      minWorkers: 1,
      maxWorkers: 6,
      retries: 3,
      workers: { desired: 6, running: 6 },
      stats: { wait: 412, active: 11, failed: 37, delayed: 0, ts: nowIso() },
    });
    const outbox = makeQueue({
      name: 'webhook-outbox',
      workerService: 'platform_dispatcher',
      stack: 'platform',
      cacheCluster: 'platform/sessions',
      cacheStack: 'platform',
      cacheName: 'sessions',
      convention: 'list',
      listKey: 'outbox:webhooks',
      scalePerJobs: 200,
      minWorkers: 0,
      maxWorkers: 2,
      retries: 8,
      workers: { desired: 1, running: 1 },
      stats: { wait: 7, active: 1, failed: 0, delayed: 0, ts: nowIso() },
    });

    store.extra.queues = {
      queues: [emails, resize, outbox],
      dlq: {
        [key(resize)]: [
          '{"jobId":"9021","file":"hero-4k.png","error":"sharp: input image exceeds pixel limit","attempts":3}',
          '{"jobId":"9017","file":"catalog-07.webp","error":"ETIMEDOUT fetching source from s3","attempts":3}',
          '{"jobId":"8996","file":"banner.avif","error":"unsupported color profile","attempts":3}',
        ],
      },
    } satisfies QueuesState;
  },

  handlers: {
    'queues.list': (_i, s): QueueView[] =>
      [...getState(s).queues].sort((a, b) => key(a).localeCompare(key(b))),

    'queues.overview': (_i, s): QueuesOverview => {
      const st = getState(s);
      const byWorker = new Map<string, number>();
      let totalWait = 0;
      let totalActive = 0;
      let totalFailed = 0;
      for (const q of st.queues) {
        byWorker.set(q.workerService, q.workers.running);
        totalWait += q.stats?.wait ?? 0;
        totalActive += q.stats?.active ?? 0;
        totalFailed += q.stats?.failed ?? 0;
      }
      return {
        queues: st.queues.length,
        workersRunning: [...byWorker.values()].reduce((n, v) => n + v, 0),
        totalWait,
        totalActive,
        totalFailed,
      };
    },

    'queues.stats': (i, s): QueueDepthSample => liveSample(require_(getState(s), i)),

    'queues.attach': (i, s): QueueView => {
      const b = i as Partial<QueueView> & { workerService: string; name: string; cacheCluster: string };
      const st = getState(s);
      if (st.queues.some((q) => q.workerService === b.workerService && q.name === b.name)) {
        throw new Error(`queue "${b.name}" already exists on ${b.workerService}`);
      }
      const slash = b.cacheCluster.indexOf('/');
      const q = makeQueue({
        ...b,
        stack: slash > 0 ? b.cacheCluster.slice(0, slash) : 'storefront',
        cacheStack: slash > 0 ? b.cacheCluster.slice(0, slash) : 'storefront',
        cacheName: slash > 0 ? b.cacheCluster.slice(slash + 1) : b.cacheCluster,
        workers: { desired: b.minWorkers ?? 1, running: b.minWorkers ?? 1 },
        stats: { wait: 0, active: 0, failed: 0, delayed: 0, ts: nowIso() },
      });
      st.queues = [...st.queues, q];
      return q;
    },

    'queues.update': (i, s): QueueView => {
      const b = i as Partial<QueueView> & { workerService: string; name: string };
      const st = getState(s);
      const q = st.queues.find((x) => x.workerService === b.workerService && x.name === b.name);
      if (!q) throw new Error('queue not found');
      Object.assign(q, {
        scalePerJobs: b.scalePerJobs ?? q.scalePerJobs,
        minWorkers: b.minWorkers ?? q.minWorkers,
        maxWorkers: b.maxWorkers ?? q.maxWorkers,
        retries: b.retries ?? q.retries,
        dlq: b.dlq ?? q.dlq,
      });
      return q;
    },

    'queues.remove': (i, s): { queue: string; removed: true } => {
      const st = getState(s);
      const q = require_(st, i);
      st.queues = st.queues.filter((x) => x !== q);
      delete st.dlq[key(q)];
      return { queue: q.name, removed: true };
    },

    'queues.retryFailed': (i, s): QueueRetryResult => {
      const { limit } = i as { limit?: number };
      const q = require_(getState(s), i);
      const failed = q.stats?.failed ?? 0;
      const moved = Math.min(failed, limit ?? 100);
      if (q.stats) {
        q.stats = { ...q.stats, failed: failed - moved, wait: q.stats.wait + moved, ts: nowIso() };
      }
      return { queue: q.name, moved, remaining: failed - moved };
    },

    'queues.drain': (i, s): QueueDrainResult => {
      const q = require_(getState(s), i);
      const removed = (q.stats?.wait ?? 0) + (q.stats?.delayed ?? 0);
      if (q.stats) q.stats = { ...q.stats, wait: 0, delayed: 0, ts: nowIso() };
      return { queue: q.name, removed };
    },

    'queues.dlqList': (i, s): QueueDlqItemView[] => {
      const { limit } = i as { limit?: number };
      const st = getState(s);
      const q = require_(st, i);
      return (st.dlq[key(q)] ?? [])
        .slice(0, limit ?? 50)
        .map((payload, index) => ({ index, payload }));
    },

    'queues.dlqRequeue': (i, s): QueueRequeueResult => {
      const { limit } = i as { limit?: number };
      const st = getState(s);
      const q = require_(st, i);
      const dead = st.dlq[key(q)] ?? [];
      const moved = Math.min(dead.length, limit ?? 100);
      st.dlq[key(q)] = dead.slice(moved);
      if (q.stats) q.stats = { ...q.stats, wait: q.stats.wait + moved, ts: nowIso() };
      return { queue: q.name, moved, remaining: dead.length - moved };
    },
  },
};
