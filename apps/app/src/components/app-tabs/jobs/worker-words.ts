import { scaleDownWords, type QueueConnectedView, type QueueDepthSample, type QueueView } from '@swarmy/core';
import type { WorkerRow } from './workers-model';

/**
 * A worker row's sentence and tech line (board AppJobs): copies, each
 * queue's live depth and, for BullMQ, how many workers are connected
 * (`queues.connectedWorkers` — what `Queue.getWorkers()` reports). BullMQ
 * keeps a worker's concurrency inside its process and Redis never records
 * it, so the row says that instead of showing a number it can't know.
 * PURE — unit-tested in worker-words.test.ts.
 */

export type QueueKeyed<T> = ReadonlyMap<string, T>;
export const queueKey = (q: Pick<QueueView, 'workerService' | 'name'>): string => `${q.workerService}/${q.name}`;

export const CONCURRENCY_NOTE = "concurrency is set in the worker's code (new Worker(…, { concurrency })); Redis doesn't record it";

const copies = (c: { desired: number; running: number }): string =>
  c.running < c.desired ? `${c.running} of ${c.desired} copies up` : `${c.desired} ${c.desired === 1 ? 'copy' : 'copies'}`;

function connectedSay(c: QueueConnectedView | undefined): string {
  if (c?.connected == null) return '';
  return `, ${c.connected} ${c.connected === 1 ? 'worker' : 'workers'} connected`;
}

function connectedTech(c: QueueConnectedView | undefined): string {
  if (!c) return '';
  if (c.connected !== null) return ` · ${c.connected} connected (CLIENT LIST, as Queue.getWorkers())${c.names.length ? `: ${c.names.join(', ')}` : ''}`;
  return c.reason === 'raw-list' ? " · a raw list's consumers don't name their connections" : " · connections not read: the cache didn't answer";
}

export function workerSay(r: WorkerRow, depth: QueueKeyed<QueueDepthSample | null>, connected: QueueKeyed<QueueConnectedView | undefined>): string {
  const queues = r.queues.map((q) => {
    const d = depth.get(queueKey(q));
    if (!d) return `${q.name}: not measured yet`;
    return `${q.name}: ${d.wait.toLocaleString()} waiting, ${d.active} in progress${d.failed ? `, ${d.failed} failed` : ''}${connectedSay(connected.get(queueKey(q)))}`;
  });
  return [copies(r.copies), ...queues].join(' · ');
}

export function workerTech(r: WorkerRow, connected: QueueKeyed<QueueConnectedView | undefined>): string {
  if (!r.queues.length) return `${r.service} · no published port, no route`;
  const lines = r.queues.map(
    (q) =>
      `${q.name} ${q.convention} on ${q.cacheName} · ${q.minWorkers}–${q.maxWorkers} copies, 1 per ${q.scalePerJobs} waiting, ${scaleDownWords(q.minWorkers, q.cooldownSeconds)}${connectedTech(connected.get(queueKey(q)))}`,
  );
  if (r.queues.some((q) => q.convention === 'bullmq')) lines.push(CONCURRENCY_NOTE);
  return lines.join(' · ');
}
