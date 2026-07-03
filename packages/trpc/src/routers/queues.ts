import { z } from 'zod';
import {
  AttachQueueInput,
  QueueBatchInput,
  QueueDlqListInput,
  QueueRefInput,
  UpdateQueueInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachQueue,
  dlqList,
  dlqRequeue,
  drainQueue,
  listQueues,
  queueStats,
  queuesOverview,
  removeQueue,
  retryFailed,
  updateQueue,
} from '../services/queues.service';

/** Optional stack scope for list/overview procedures (no input = org-wide). */
const StackScopeInput = z.object({ stack: z.string().min(1).optional() }).optional();

/**
 * Queues (slice B1) — queue defs in the `swarmy.queues` JSON label on the
 * worker service, depths via redis-cli exec on the backing cache primary,
 * autoscaling by the queue-reconcile worker, DLQ browse/requeue actions.
 * Stack-scoped IA: list/overview take an optional `stack`, filtered by the
 * queue's backing worker service's stack.
 */
export const queuesRouter = router({
  /** Aggregates for the Queues page hero (optionally one stack's). */
  overview: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => queuesOverview(ctx, input?.stack)),

  /** Every queue in the org (inventory scan + last stamped stats). */
  list: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => listQueues(ctx, input?.stack)),

  /** Attach a queue to a worker service (label write). */
  attach: orgProcedure.input(AttachQueueInput).mutation(({ ctx, input }) => attachQueue(ctx, input)),

  /** Update a queue's rules (matched by name on the worker service). */
  update: orgProcedure.input(UpdateQueueInput).mutation(({ ctx, input }) => updateQueue(ctx, input)),

  /** Remove a queue def (clears the labels when it was the last one). */
  remove: orgProcedure.input(QueueRefInput).mutation(({ ctx, input }) => removeQueue(ctx, input)),

  /** Live depth sample from the cache primary (falls back to the label stamp). */
  stats: orgProcedure.input(QueueRefInput).query(({ ctx, input }) => queueStats(ctx, input)),

  /** Bounded retry batch: BullMQ failed → wait. */
  retryFailed: orgProcedure
    .input(QueueBatchInput)
    .mutation(({ ctx, input }) => retryFailed(ctx, input)),

  /** Drain: delete waiting (+ delayed) jobs. */
  drain: orgProcedure.input(QueueRefInput).mutation(({ ctx, input }) => drainQueue(ctx, input)),

  /** Browse the dead-letter list (`<q>:dead`). */
  dlqList: orgProcedure.input(QueueDlqListInput).query(({ ctx, input }) => dlqList(ctx, input)),

  /** Bounded requeue batch: dead → wait. */
  dlqRequeue: orgProcedure
    .input(QueueBatchInput)
    .mutation(({ ctx, input }) => dlqRequeue(ctx, input)),
});
