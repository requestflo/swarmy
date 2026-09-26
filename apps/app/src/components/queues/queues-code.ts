import type { QueueView } from '@swarmy/core';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';

/** The queue stores as swarmy.yaml resources, and each worker's swarmy.queues label as swarmy reads it. */
export function queuesCode(stack: string, queues: QueueView[]): CodeTab[] {
  const caches = [...new Set(queues.map((q) => q.cacheName))];
  const resources = Object.fromEntries(caches.map((c) => [c, 'queue' as const]));
  const tabs: CodeTab[] = [
    { label: 'swarmy.yaml', code: withHeader(`${stack} — queue stores`, toYaml({ resources })) },
  ];
  if (queues.length) {
    const byWorker = new Map<string, QueueView[]>();
    for (const q of queues) byWorker.set(q.workerService, [...(byWorker.get(q.workerService) ?? []), q]);
    tabs.push({
      label: 'labels',
      code: [...byWorker.entries()]
        .map(
          ([w, qs]) =>
            `# ${w}\nswarmy.queues: ${JSON.stringify(
              qs.map((q) => ({
                name: q.name,
                cacheCluster: q.cacheCluster,
                convention: q.convention,
                ...(q.listKey ? { listKey: q.listKey } : {}),
                scalePerJobs: q.scalePerJobs,
                minWorkers: q.minWorkers,
                maxWorkers: q.maxWorkers,
                retries: q.retries,
                dlq: q.dlq,
              })),
              null,
              2,
            )}`,
        )
        .join('\n\n'),
    });
  }
  return tabs;
}
