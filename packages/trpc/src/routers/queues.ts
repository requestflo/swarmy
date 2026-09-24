import { z } from 'zod';
import {
  AttachQueueInput,
  QueueBatchInput,
  QueueDlqListInput,
  QueueRefInput,
  UpdateQueueInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import {
  StudioCleanInput,
  StudioClusterInput,
  StudioJobInput,
  StudioJobsInput,
  StudioPauseInput,
  StudioQueueInput,
  StudioRatesInput,
  StudioRetryAllInput,
  StudioRetryInput,
} from '../services/queue-studio.core';
import {
  studioAction,
  studioClusters,
  studioJob,
  studioJobs,
  studioOverview,
  studioRates,
} from '../services/queue-studio.service';
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
  remove: abacProcedure('data.destroy').input(QueueRefInput).mutation(({ ctx, input }) => removeQueue(ctx, input)),

  /** Live depth sample from the cache primary (falls back to the label stamp). */
  stats: orgProcedure.input(QueueRefInput).query(({ ctx, input }) => queueStats(ctx, input)),

  /** Bounded retry batch: BullMQ failed → wait. */
  retryFailed: abacProcedure('data.write', resolveStackByName)
    .input(QueueBatchInput)
    .mutation(({ ctx, input }) => retryFailed(ctx, input)),

  /** Drain: delete waiting (+ delayed) jobs. */
  drain: abacProcedure('data.destroy').input(QueueRefInput).mutation(({ ctx, input }) => drainQueue(ctx, input)),

  /** Browse the dead-letter list (`<q>:dead`). */
  dlqList: abacProcedure('data.read', resolveStackByName).input(QueueDlqListInput).query(({ ctx, input }) => dlqList(ctx, input)),

  /** Bounded requeue batch: dead → wait. */
  dlqRequeue: abacProcedure('data.write', resolveStackByName)
    .input(QueueBatchInput)
    .mutation(({ ctx, input }) => dlqRequeue(ctx, input)),

  // ── Queue studio: any BullMQ queue on a managed cache, through the agent ──
  // Reads can show job payloads, so they need `data.read` (members get it
  // outside production). Writes need `data.write`, and removing jobs needs
  // `data.destroy`. The stack is the ABAC resource, so production rules apply.

  /** Managed cache clusters the studio can open (queue-purpose first). */
  studioClusters: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => studioClusters(ctx, input?.stack)),

  /** Discover queues by key pattern + counts by state + last rate point. */
  studioOverview: abacProcedure('data.read', resolveStackByName)
    .input(StudioClusterInput)
    .query(({ ctx, input }) => studioOverview(ctx, input)),

  /** One page of jobs in a state (payloads cut to 2 KB). */
  studioJobs: abacProcedure('data.read', resolveStackByName)
    .input(StudioJobsInput)
    .query(({ ctx, input }) => studioJobs(ctx, input)),

  /** One job in full: payload, progress, attempts, stacktrace, logs. */
  studioJob: abacProcedure('data.read', resolveStackByName)
    .input(StudioJobInput)
    .query(({ ctx, input }) => studioJob(ctx, input)),

  /** Throughput / failure-rate series from the observability store. */
  studioRates: abacProcedure('data.read', resolveStackByName)
    .input(StudioRatesInput)
    .query(({ ctx, input }) => studioRates(ctx, input)),

  /** Retry one failed/completed job (BullMQ Job.retry). */
  studioRetry: abacProcedure('data.write', resolveStackByName)
    .input(StudioRetryInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'retry', id: input.id, from: input.from })),

  /** Retry every failed/completed job (BullMQ Queue.retryJobs). */
  studioRetryAll: abacProcedure('data.write', resolveStackByName)
    .input(StudioRetryAllInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'retryAll', from: input.from })),

  /** Promote one delayed job to waiting now. */
  studioPromote: abacProcedure('data.write', resolveStackByName)
    .input(StudioJobInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'promote', id: input.id })),

  /** Promote every delayed job. */
  studioPromoteAll: abacProcedure('data.write', resolveStackByName)
    .input(StudioQueueInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'promoteAll' })),

  /** Pause or resume a queue (workers stop picking jobs; nothing is lost). */
  studioPause: abacProcedure('data.write', resolveStackByName)
    .input(StudioPauseInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'pause', paused: input.paused })),

  /** Remove one job (+ its children). Refused while a worker holds it. */
  studioRemove: abacProcedure('data.destroy', resolveStackByName)
    .input(StudioJobInput)
    .mutation(({ ctx, input }) => studioAction(ctx, input, { kind: 'remove', id: input.id })),

  /** Remove jobs in a state older than the grace period (BullMQ Queue.clean). */
  studioClean: abacProcedure('data.destroy', resolveStackByName)
    .input(StudioCleanInput)
    .mutation(({ ctx, input }) =>
      studioAction(ctx, input, { kind: 'clean', state: input.state, graceMs: input.graceMs, limit: input.limit }),
    ),
});
