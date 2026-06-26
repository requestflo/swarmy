import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants';

/** Negotiated protocol version carried on every envelope. */
export const ProtocolVersion = z.literal(PROTOCOL_VERSION);

/** Per-frame id (we generate via `crypto.randomUUID()`). */
export const MessageId = z.string().uuid();
export type MessageId = z.infer<typeof MessageId>;

/** Epoch milliseconds. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * A controller-side Node id (Prisma `@id @default(cuid())`). Kept as a loose
 * non-empty string so the wire contract is not coupled to a specific id format.
 */
export const NodeId = z.string().min(1);
export type NodeId = z.infer<typeof NodeId>;

/** Correlates a controller command to its `commandResult`. Distinct from `id`. */
export const CommandId = MessageId;
export type CommandId = z.infer<typeof CommandId>;

/**
 * Wraps an inner message (a discriminated union member) with envelope metadata.
 * Uses `.and()` so the union's narrowing on `type` survives.
 */
export const envelope = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ v: ProtocolVersion, id: MessageId, ts: Timestamp }).and(inner);
