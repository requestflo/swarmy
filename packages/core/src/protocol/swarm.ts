import { z } from 'zod';
import { CommandId } from './primitives';

/**
 * Swarm init/join orchestration (node-onboarding epic, PHASE-2+).
 *
 * A single controller→agent command, `swarmJoin`, drives the local box's swarm
 * membership against its OWN Docker socket — the controller never touches a
 * remote socket. Two modes:
 *
 *   - `init`  — the FIRST node in an org runs `docker swarm init` and becomes the
 *               manager. On success it returns the freshly-minted worker+manager
 *               join tokens (Docker's own `SWMTKN-…`), which the controller
 *               stores (encrypted) so later nodes can join.
 *   - `join`  — a subsequent node runs `docker swarm join` against the manager's
 *               advertise address using a stored join token.
 *
 * This file is additive: it is wired into the discriminated unions via
 * INTEGRATION snippets (see the epic return). The parser ignores unknown command
 * types gracefully, so adding it does NOT require a PROTOCOL_VERSION bump.
 */

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const SwarmMode = z.enum(['init', 'join']);
export type SwarmMode = z.infer<typeof SwarmMode>;

export const SwarmRole = z.enum(['manager', 'worker']);
export type SwarmRole = z.infer<typeof SwarmRole>;

export const SwarmJoinPayload = z
  .object({
    ...cmd,
    mode: SwarmMode,
    /** join only: Docker swarm join token (`SWMTKN-…`). */
    joinToken: z.string().min(1).optional(),
    /** join only: `host:port` of an existing manager to dial. */
    managerAddr: z.string().min(1).optional(),
    /** init/join: address advertised to other nodes (multi-NIC disambiguation). */
    advertiseAddr: z.string().min(1).optional(),
    /** join: the role this node should take (defaults to worker). */
    role: SwarmRole.default('worker'),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'join') {
      if (!v.joinToken) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'join requires joinToken', path: ['joinToken'] });
      }
      if (!v.managerAddr) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'join requires managerAddr', path: ['managerAddr'] });
      }
    }
  });
export type SwarmJoinPayload = z.infer<typeof SwarmJoinPayload>;

export const SwarmJoinMsg = z.object({
  type: z.literal('swarmJoin'),
  payload: SwarmJoinPayload,
});
export type SwarmJoinMsg = z.infer<typeof SwarmJoinMsg>;

/** Worker + manager Docker join tokens returned after a successful `init`. */
export const SwarmJoinTokens = z.object({
  worker: z.string(),
  manager: z.string(),
});
export type SwarmJoinTokens = z.infer<typeof SwarmJoinTokens>;

/**
 * Result of `swarmJoin` (carried in `commandResult.result`). On `init` the agent
 * fills `joinTokens` + `managerAddr`; on `join` only `swarmNodeId`.
 */
export const SwarmJoinResult = z.object({
  mode: SwarmMode,
  swarmNodeId: z.string(),
  managerAddr: z.string().optional(),
  joinTokens: SwarmJoinTokens.optional(),
});
export type SwarmJoinResult = z.infer<typeof SwarmJoinResult>;

/** Agent-enforced execution timeout (ms) for `swarmJoin`. */
export const SWARM_JOIN_TIMEOUT_MS = 60_000;
