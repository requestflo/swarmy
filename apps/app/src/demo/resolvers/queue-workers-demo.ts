import type { QueueConnectedView, QueueView } from '@swarmy/core';
import type { DemoHandler } from '../types';

/**
 * `queues.connectedWorkers` in demo mode: each running copy of a BullMQ
 * worker holds one connection (unnamed, like most BullMQ workers), except
 * the media worker, which names its workers `resize-<n>` and has one copy
 * that hasn't connected to the cache. A raw list's consumers don't name their connections, the
 * same answer the real service gives.
 */
export const queueWorkersDemo: Record<string, DemoHandler> = {
  'queues.connectedWorkers': (i, s): QueueConnectedView => {
    const { workerService, queue } = i as { workerService: string; queue: string };
    const q = (s.extra.queues as { queues: QueueView[] }).queues.find((x) => x.workerService === workerService && x.name === queue);
    if (!q) throw new Error('queue not found');
    const base = { queue: q.name, workerService: q.workerService, names: [] as string[], measuredAt: new Date().toISOString() };
    if (q.convention !== 'bullmq') return { ...base, connected: null, reason: 'raw-list' };
    const media = q.workerService === 'storefront_media-worker';
    const connected = Math.max(0, q.workers.running - (media ? 1 : 0));
    const names = media ? Array.from({ length: connected }, (_, n) => `resize-${n + 1}`) : [];
    return { ...base, connected, names, reason: null };
  },
};
