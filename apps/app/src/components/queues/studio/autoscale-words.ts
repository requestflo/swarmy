import { cooldownWords, scaleDownWords, type QueueView } from '@swarmy/core';

/**
 * The queue studio's autoscale sentences, from the worker's `swarmy.queues`
 * def and its `swarmy.queues.calm` clock — the rule the queue-reconcile
 * worker runs (`autoscaleStep`, @swarmy/core queue-autoscale.ts). PURE —
 * unit-tested in autoscale-words.test.ts.
 */

const copies = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;

/** "Autoscale: email-worker 1 → 4 copies, one per 25 waiting jobs, back to 1 after 10 min calm." */
export function autoscaleLine(q: QueueView): string {
  const svc = q.workerService.startsWith(`${q.stack}_`) ? q.workerService.slice(q.stack.length + 1) : q.workerService;
  if (q.maxWorkers <= q.minWorkers) return `Workers: ${svc} stays at ${copies(q.minWorkers)}.`;
  return `Autoscale: ${svc} ${q.minWorkers} → ${q.maxWorkers} copies, one per ${q.scalePerJobs.toLocaleString()} waiting jobs, ${scaleDownWords(q.minWorkers, q.cooldownSeconds)}.`;
}

/**
 * The longest cooldown among the queues one worker consumes — the one the
 * worker waits out, since it scales for all of them at once.
 */
export function workerCooldown(all: readonly QueueView[], workerService: string): number {
  return all.filter((q) => q.workerService === workerService).reduce((m, q) => Math.max(m, q.cooldownSeconds), 0);
}

/** "Calm for 4 min: down to 2 copies in 6 min." — null when no drop is pending. */
export function calmLine(q: Pick<QueueView, 'calm' | 'workers'>, cooldownSeconds: number, now: number): string | null {
  if (!q.calm || q.calm.peak >= q.workers.desired) return null;
  const since = Date.parse(q.calm.since);
  if (!Number.isFinite(since)) return null;
  const left = since + cooldownSeconds * 1000 - now;
  const head = `Calm for ${cooldownWords(Math.max(0, now - since) / 1000)}: down to ${copies(q.calm.peak)}`;
  return left > 60_000 ? `${head} in ${cooldownWords(left / 1000)}.` : `${head} within a minute.`;
}
