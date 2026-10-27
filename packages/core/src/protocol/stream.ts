import { z } from 'zod';
import { MessageId } from './primitives';

/**
 * A credit-flow byte stream from an agent to the controller (first user:
 * snapshot downloads, `snapshot-dump.ts`). Additive to the JSON protocol:
 *
 *   controller → agent : <a start frame, e.g. snapshotDump>, streamCredit, streamCancel
 *   agent → controller : binary chunk frames (`stream-frame.ts`), then one streamEnd
 *
 * The controller grants N chunks; the agent sends at most that many and then
 * waits for more credit (`stream-flow.ts`), which carries the browser's
 * backpressure all the way to the process producing the bytes. Either side can
 * stop: the controller with `streamCancel`, the agent with a failed `streamEnd`.
 * An agent only ever sends these after a controller asked for a stream, so an
 * older controller never sees a frame it can't parse.
 */

/** Bytes per chunk the controller asks for (one binary WS frame each). */
export const STREAM_CHUNK_BYTES = 256 * 1024;
/** Largest chunk a start frame may ask for (well under the 16 MiB WS frame ceiling). */
export const STREAM_MAX_CHUNK_BYTES = 1024 * 1024;
/** Chunks in flight + buffered per stream: 8 × 256 KiB = 2 MiB of controller memory. */
export const STREAM_WINDOW = 8;
/** Most credit a sender may hold at once (a bad grant can't make it flood). */
export const STREAM_MAX_CREDIT = 64;

/** Stable reasons a stream ended without finishing. */
export const StreamErrorCode = z.enum([
  'E_CANCELED', // the controller (or the browser behind it) stopped reading
  'E_TOO_LARGE', // past the byte cap
  'E_STALLED', // no credit for too long: the reader went away
  'E_DISABLED', // the agent's local veto (SWARMY_ALLOW_SNAPSHOT_DOWNLOAD=false)
  'E_BUSY', // too many streams on this agent already
  'E_NOT_FOUND', // the path isn't in the snapshot
  'E_SOURCE', // the producer (restic) failed
  'E_PROTOCOL', // a sender broke the credit/sequence contract
  'E_AGENT_GONE', // the agent's link dropped mid-stream
]);
export type StreamErrorCode = z.infer<typeof StreamErrorCode>;

// ── controller → agent ──────────────────────────────────────────────────────

export const StreamCreditPayload = z.object({
  streamId: MessageId,
  grant: z.number().int().min(1).max(STREAM_MAX_CREDIT),
});
export type StreamCreditPayload = z.infer<typeof StreamCreditPayload>;
export const StreamCreditMsg = z.object({ type: z.literal('streamCredit'), payload: StreamCreditPayload });
export type StreamCreditMsg = z.infer<typeof StreamCreditMsg>;

export const StreamCancelPayload = z.object({
  streamId: MessageId,
  reason: z.string().max(200).optional(),
});
export type StreamCancelPayload = z.infer<typeof StreamCancelPayload>;
export const StreamCancelMsg = z.object({ type: z.literal('streamCancel'), payload: StreamCancelPayload });
export type StreamCancelMsg = z.infer<typeof StreamCancelMsg>;

// ── agent → controller ──────────────────────────────────────────────────────

/** The last frame of a stream: it finished (`ok`), or why it stopped. */
export const StreamEndPayload = z.union([
  z.object({
    streamId: MessageId,
    ok: z.literal(true),
    bytes: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
  }),
  z.object({
    streamId: MessageId,
    ok: z.literal(false),
    bytes: z.number().int().nonnegative(),
    error: z.object({ code: StreamErrorCode, message: z.string().max(2000) }),
  }),
]);
export type StreamEndPayload = z.infer<typeof StreamEndPayload>;
export const StreamEndMsg = z.object({ type: z.literal('streamEnd'), payload: StreamEndPayload });
export type StreamEndMsg = z.infer<typeof StreamEndMsg>;
