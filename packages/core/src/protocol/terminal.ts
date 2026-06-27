import { z } from 'zod';
import { MessageId } from './primitives';

/**
 * Interactive terminal (PTY) session protocol. Distinct from the one-shot
 * `execCommand`: a terminal is a long-lived, bidirectional session correlated
 * by `sessionId` (a `MessageId`/uuid), not by `commandId`.
 *
 * Direction:
 *   controller → agent : termStart, termInput, termResize, termClose
 *   agent → controller : termStarted, termData, termExit
 *
 * Wiring: add the four controller→agent members to `ControllerToAgentMessage`
 * and the three agent→controller members to `AgentToControllerMessage` in
 * `protocol/messages.ts`. Export this file from `protocol/index.ts`. See the
 * INTEGRATION section of the epic for the exact snippets.
 *
 * Subpath: `@swarmy/core/protocol`.
 */

/** Correlates every frame of one interactive terminal session. */
export const SessionId = MessageId;
export type SessionId = z.infer<typeof SessionId>;

/** Max bytes of terminal output carried in a single `termData` frame. */
export const MAX_TERM_CHUNK_BYTES = 32_768; // 32 KiB; agent splits larger output.

/** Error codes the agent may report when a session fails to start. */
export const TermErrorCode = z.enum([
  'E_EXEC_DISABLED', // container exec gated off (SWARMY_ALLOW_EXEC=false)
  'E_NODE_SHELL_DISABLED', // node shell gated off
  'E_NO_SUCH_CONTAINER', // target container not found
  'E_NO_SHELL', // no usable shell in the image
  'E_SPAWN', // exec / spawn failed
]);
export type TermErrorCode = z.infer<typeof TermErrorCode>;

/** `/term/ws` browser-facing close codes (4xxx = swarmy-specific). */
export const TermCloseCode = {
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  SESSION_GONE: 4404,
  IDLE: 4408,
  SUPERSEDED: 4409,
} as const;
export type TermCloseCode = (typeof TermCloseCode)[keyof typeof TermCloseCode];

/** What the PTY attaches to. */
export const TermTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    containerId: z.string().min(1),
    /** [] ⇒ agent probes for a shell (try bash, fall back to sh). */
    cmd: z.array(z.string()).default([]),
    user: z.string().optional(),
    workdir: z.string().optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('nodeShell'),
    /** [] ⇒ login shell ($SHELL || /bin/sh -l). */
    cmd: z.array(z.string()).default([]),
    user: z.string().optional(),
  }),
]);
export type TermTarget = z.infer<typeof TermTarget>;

// ── controller → agent ──────────────────────────────────────────────────────

export const TermStartPayload = z.object({
  sessionId: SessionId,
  target: TermTarget,
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
  term: z.string().default('xterm-256color'),
  idleTimeoutMs: z.number().int().nonnegative().default(300_000),
});
export type TermStartPayload = z.infer<typeof TermStartPayload>;
export const TermStartMsg = z.object({
  type: z.literal('termStart'),
  payload: TermStartPayload,
});
export type TermStartMsg = z.infer<typeof TermStartMsg>;

/** Keystrokes. Terminal input is binary → base64 always. */
export const TermInputPayload = z.object({
  sessionId: SessionId,
  seq: z.number().int().nonnegative(),
  data: z.string(),
  encoding: z.literal('base64').default('base64'),
});
export type TermInputPayload = z.infer<typeof TermInputPayload>;
export const TermInputMsg = z.object({
  type: z.literal('termInput'),
  payload: TermInputPayload,
});
export type TermInputMsg = z.infer<typeof TermInputMsg>;

export const TermResizePayload = z.object({
  sessionId: SessionId,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TermResizePayload = z.infer<typeof TermResizePayload>;
export const TermResizeMsg = z.object({
  type: z.literal('termResize'),
  payload: TermResizePayload,
});
export type TermResizeMsg = z.infer<typeof TermResizeMsg>;

/** Controller-initiated teardown (tab closed, admin kill, policy timeout). */
export const TermClosePayload = z.object({ sessionId: SessionId });
export type TermClosePayload = z.infer<typeof TermClosePayload>;
export const TermCloseMsg = z.object({
  type: z.literal('termClose'),
  payload: TermClosePayload,
});
export type TermCloseMsg = z.infer<typeof TermCloseMsg>;

// ── agent → controller ──────────────────────────────────────────────────────

export const TermStartedPayload = z.union([
  z.object({ sessionId: SessionId, ok: z.literal(true) }),
  z.object({
    sessionId: SessionId,
    ok: z.literal(false),
    error: z.object({ code: TermErrorCode, message: z.string() }),
  }),
]);
export type TermStartedPayload = z.infer<typeof TermStartedPayload>;
export const TermStartedMsg = z.object({
  type: z.literal('termStarted'),
  payload: TermStartedPayload,
});
export type TermStartedMsg = z.infer<typeof TermStartedMsg>;

/** Output bytes. With a TTY, stdout/stderr are merged ⇒ always `stdout`. */
export const TermDataPayload = z.object({
  sessionId: SessionId,
  stream: z.enum(['stdout', 'stderr']).default('stdout'),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  encoding: z.literal('base64').default('base64'),
});
export type TermDataPayload = z.infer<typeof TermDataPayload>;
export const TermDataMsg = z.object({
  type: z.literal('termData'),
  payload: TermDataPayload,
});
export type TermDataMsg = z.infer<typeof TermDataMsg>;

export const TermExitPayload = z.object({
  sessionId: SessionId,
  exitCode: z.number().int().nullable(),
  signal: z.string().optional(),
  reason: z.enum(['exit', 'idle_timeout', 'killed', 'agent_shutdown', 'error']),
});
export type TermExitPayload = z.infer<typeof TermExitPayload>;
export const TermExitMsg = z.object({
  type: z.literal('termExit'),
  payload: TermExitPayload,
});
export type TermExitMsg = z.infer<typeof TermExitMsg>;

/** Convenience unions (the discriminated-union members live in messages.ts). */
export const TerminalControllerToAgentMsgs = [
  TermStartMsg,
  TermInputMsg,
  TermResizeMsg,
  TermCloseMsg,
] as const;
export const TerminalAgentToControllerMsgs = [
  TermStartedMsg,
  TermDataMsg,
  TermExitMsg,
] as const;
