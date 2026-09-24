/**
 * `queueOp` — one bounded BullMQ operation on a managed cache member
 * (queue studio + the queue-reconcile sampler).
 *
 * The controller resolves the cache PRIMARY's running container and the node
 * it runs on, then sends a typed op (never a shell string). The agent turns
 * it into one `EVAL` through the engine's own CLI inside that container
 * (`queueEvalArgv`). The password is read from the member's mounted secret
 * file, so it never crosses the WS. The agent returns the parsed typed reply
 * (`parseQueueOpReply`).
 *
 * This is a fixed operation set, not arbitrary exec, so it isn't behind the
 * terminal exec gate. Every write is ABAC-gated and audited controller-side
 * before it is dispatched. Timeout: `DEFAULT_COMMAND_TIMEOUTS.queueOp`.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { QueueOp } from '../bullmq/ops';

export {
  BULL_CLEAN_STATES,
  BULL_STATES,
  BullCleanState,
  BullJobId,
  BullJobRow,
  BullPrefix,
  BullQueueName,
  BullQueueSample,
  BullState,
  QUEUE_DATA_MAX,
  QUEUE_PAGE_MAX,
  QueueJobReply,
  QueueJobsReply,
  QueueMutationReply,
  QueueOp,
  QueueOpError,
  QueueOverviewReply,
  isQueueWrite,
  parseCliJson,
  parseQueueOpReply,
  queueBacklog,
  queueEvalArgv,
  queueOpEval,
} from '../bullmq/ops';
export type {
  BullCounts,
  QueueEval,
  QueueOpInput,
  QueueOpKind,
  QueueOpReply,
} from '../bullmq/ops';
export { VENDORED_BULLMQ_VERSION } from '../bullmq/vendored.generated';
/** The vendored BullMQ mutation scripts (drift-tested against the installed bullmq). */
export * as BULLMQ_VENDORED from '../bullmq/vendored.generated';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const QueueOpPayload = z.object({
  ...cmd,
  /** The cache member's running container on the receiving node. */
  target: z.object({ containerId: z.string().min(1) }),
  engine: z.enum(['valkey', 'redis']),
  op: QueueOp,
});
export type QueueOpPayload = z.infer<typeof QueueOpPayload>;

export const QueueOpMsg = z.object({
  type: z.literal('queueOp'),
  payload: QueueOpPayload,
});
export type QueueOpMsg = z.infer<typeof QueueOpMsg>;
