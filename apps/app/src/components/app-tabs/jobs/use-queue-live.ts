import { useQueries } from '@tanstack/react-query';
import type { QueueConnectedView, QueueDepthSample, QueueView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { queueKey } from './worker-words';

/**
 * Each queue's live depth (`queues.stats`, falling back to the stamped
 * sample) and, per BullMQ queue, its connected workers
 * (`queues.connectedWorkers`), keyed `<workerService>/<queue>`.
 */
export function useQueueLive(queues: QueueView[] | undefined): {
  depth: Map<string, QueueDepthSample | null>;
  connected: Map<string, QueueConnectedView | undefined>;
} {
  const trpc = useTRPC();
  const list = queues ?? [];
  const bull = list.filter((q) => q.convention === 'bullmq');
  const stats = useQueries({
    queries: list.map((q) => ({ ...trpc.queues.stats.queryOptions({ workerService: q.workerService, queue: q.name }), refetchInterval: 15_000 })),
  });
  const conn = useQueries({
    queries: bull.map((q) => ({
      ...trpc.queues.connectedWorkers.queryOptions({ workerService: q.workerService, queue: q.name }),
      refetchInterval: 30_000,
      retry: false,
    })),
  });
  return {
    depth: new Map(list.map((q, i) => [queueKey(q), stats[i]?.data ?? q.stats])),
    connected: new Map(bull.map((q, i) => [queueKey(q), conn[i]?.data])),
  };
}
