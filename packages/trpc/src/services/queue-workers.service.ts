import type { QueueConnectedView, QueueRefInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { bullWorkersOf, clientNamesCommand } from './queue-workers';
import { engineOf, execOnPrimary, resolveQueue } from './queues.service';

/**
 * `queues.connectedWorkers` — how many BullMQ workers are connected to one
 * queue right now, read off the backing cache primary's CLIENT LIST (one
 * exec, the password from the container's secret file) the way BullMQ's
 * `Queue.getWorkers()` does. Read-only. A raw-list queue's consumers don't
 * name their connections, so it says so instead of guessing; a cache that
 * doesn't answer is "unreachable", never zero.
 *
 * Concurrency is not here on purpose: it's an option inside each worker's
 * process (`new Worker(q, fn, { concurrency })`) and Redis never sees it.
 */
export async function connectedWorkers(ctx: OrgContext, ref: QueueRefInput): Promise<QueueConnectedView> {
  const { worker, def, primary } = resolveQueue(ctx, ref);
  const base = { queue: def.name, workerService: worker.name, names: [] as string[], measuredAt: new Date().toISOString() };
  if (def.convention !== 'bullmq') return { ...base, connected: null, reason: 'raw-list' };
  try {
    const raw = await execOnPrimary(ctx, primary, clientNamesCommand(engineOf(primary)));
    const w = bullWorkersOf(raw, 'bull', def.name);
    return { ...base, connected: w.connected, names: w.names, reason: null };
  } catch {
    return { ...base, connected: null, reason: 'unreachable' };
  }
}
