/**
 * `queueOp` — one bounded BullMQ operation inside a managed cache member.
 *
 * The typed op becomes ONE `EVAL` through the engine's own CLI in the target
 * container (`queueEvalArgv`). The password is read there from
 * `/run/secrets/cache-password` into `REDISCLI_AUTH`, and script, keys and
 * args are positional parameters, never shell-interpolated. The reply is
 * parsed on this side (`parseQueueOpReply`), so the controller receives typed
 * JSON. Reads are swarmy's bounded read-only Lua; writes are BullMQ's own
 * vendored scripts. See `@swarmy/core` `bullmq/ops.ts` for why it isn't the
 * `bullmq` client.
 */
import type { DockerClient } from '@swarmy/core/docker';
import {
  DEFAULT_COMMAND_TIMEOUTS,
  parseQueueOpReply,
  queueEvalArgv,
  queueOpEval,
  type QueueOpPayload,
  type QueueOpReply,
} from '@swarmy/core/protocol';
import { execCapture } from './exec';

export async function queueOp(docker: DockerClient, p: QueueOpPayload): Promise<QueueOpReply> {
  const argv = queueEvalArgv(p.engine, queueOpEval(p.op));
  const res = await execCapture(docker, p.target.containerId, {
    cmd: argv,
    timeoutMs: p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUTS.queueOp,
  });
  if (res.exitCode !== 0) {
    const why = (res.stderr || res.stdout).trim().slice(-300);
    throw new Error(`queue ${p.op.kind} failed (exit ${res.exitCode}): ${why}`);
  }
  return parseQueueOpReply(p.op, res.stdout);
}
