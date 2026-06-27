/**
 * Single source of truth for protocol-level constants shared by the agent
 * (apps/agent) and the controller gateway (apps/api).
 */

/** Bumped on breaking wire changes. Pinned in the `swarmy.vN` subprotocol. */
export const PROTOCOL_VERSION = 1 as const;

/** WebSocket subprotocol advertised by the agent and required by the gateway. */
export const SUBPROTOCOL = `swarmy.v${PROTOCOL_VERSION}`;

/** Hard cap for a single WS frame (gateway `maxPayload`, agent pre-check). */
export const MAX_MESSAGE_BYTES = 1_048_576; // 1 MiB
/** Per `logChunk` payload cap; larger output is split into multiple chunks. */
export const MAX_LOG_CHUNK_BYTES = 65_536; // 64 KiB

/** First frame must be `register` within this window or the gateway closes. */
export const REGISTER_TIMEOUT_MS = 10_000;
/** Controller-dictated cadences (sent in registerAck). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_METRICS_INTERVAL_MS = 5_000;
/** A node is marked offline after this much silence (any inbound frame resets). */
export const OFFLINE_TIMEOUT_MS = DEFAULT_HEARTBEAT_INTERVAL_MS * 3;

/** Agent reconnect backoff (full-jitter). */
export const BACKOFF = {
  baseMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  /** A connection up at least this long resets the attempt counter. */
  stableMs: 60_000,
} as const;

/** Idempotency cache for already-seen command ids. */
export const COMMAND_DEDUP_TTL_MS = 600_000;
export const COMMAND_DEDUP_MAX = 1024;

/** Application-level close codes (4xxx = swarmy-specific). */
export const CloseCode = {
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  UNSUPPORTED_VERSION: 4406,
  REGISTER_TIMEOUT: 4408,
  DUPLICATE_SESSION: 4409,
  MESSAGE_TOO_LARGE: 4413,
  INTERNAL: 1011,
  RESTARTING: 1012,
  TRY_AGAIN_LATER: 1013,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Per-command execution timeouts (ms) the agent enforces. 0 = no timeout. */
export const DEFAULT_COMMAND_TIMEOUTS: Record<string, number> = {
  buildImage: 1800000,
  pruneImages: 120000,
  deployService: 120_000,
  removeService: 60_000,
  scaleService: 60_000,
  restartService: 120_000,
  pullImage: 600_000,
  execCommand: 300_000,
  applyIngress: 30_000,
  updateSwarmNode: 30_000,
  updateAgent: 300_000,
  streamLogs: 0,
  ping: 5_000,
};
