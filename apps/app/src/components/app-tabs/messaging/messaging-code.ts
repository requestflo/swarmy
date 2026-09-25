import type { QueueView, ScheduledJobView } from '@swarmy/core';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';

/** The jobs + queue resources as swarmy.yaml, and the worker's swarmy.queues label as swarmy reads it. */
export function messagingCode(stack: string, jobs: ScheduledJobView[], queues: QueueView[]): CodeTab[] {
  const jobsYaml: Record<string, { schedule: string; service?: string; image?: string; run: string; retries?: number }> = {};
  for (const j of jobs) {
    const svc = j.serviceRef?.startsWith(`${stack}_`) ? j.serviceRef.slice(stack.length + 1) : j.serviceRef;
    jobsYaml[j.name] = {
      schedule: j.schedule,
      ...(svc ? { service: svc } : j.image ? { image: j.image } : {}),
      run: j.command.join(' '),
      ...(j.retries ? { retries: j.retries } : {}),
    };
  }
  const caches = [...new Set(queues.map((q) => q.cacheName))];
  const resources = Object.fromEntries(caches.map((c) => [c, 'queue' as const]));
  const tabs: CodeTab[] = [
    {
      label: 'swarmy.yaml',
      code: withHeader(`${stack} — scheduled jobs and queue stores`, toYaml({ ...(caches.length ? { resources } : {}), jobs: jobsYaml })),
    },
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
