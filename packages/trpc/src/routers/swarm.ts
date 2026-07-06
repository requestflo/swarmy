import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import {
  demoteNode,
  promoteNode,
  revealUnlockKey,
  rotateJoinTokens,
  setAutolock,
  swarmHealth,
} from '../services/swarm-recovery.service';

/**
 * Swarm quorum monitoring + recovery (roadmap WS2). Everything here touches
 * the control plane itself — manager membership, autolock, join tokens — so
 * the WHOLE router is admin-only. Health is derived from the hub's live node
 * inventory; nothing about the swarm is stored beyond swarmy's own encrypted
 * secret material (tokens + opt-in unlock key on SwarmConfig).
 */
export const swarmRouter = router({
  /** Manager census, quorum verdict, autolock posture — derived, never stored. */
  health: adminProcedure.query(({ ctx }) => swarmHealth(ctx)),

  /**
   * Toggle manager auto-lock. Default stores the unlock key encrypted next to
   * the join tokens; `storeKey: false` returns the key ONCE in the result for
   * the operator to keep, and persists nothing.
   */
  setAutolock: adminProcedure
    .input(z.object({ enabled: z.boolean(), storeKey: z.boolean().optional() }))
    .mutation(({ ctx, input }) =>
      setAutolock(ctx, input.enabled, { storeKey: input.storeKey }),
    ),

  /** Decrypt the stored unlock key (audited). 404 when none is stored. */
  revealUnlockKey: adminProcedure.mutation(({ ctx }) => revealUnlockKey(ctx)),

  /** Rotate the worker/manager join tokens and re-store them encrypted. */
  rotateJoinTokens: adminProcedure
    .input(
      z
        .object({ roles: z.array(z.enum(['manager', 'worker'])).min(1) })
        .optional(),
    )
    .mutation(({ ctx, input }) => rotateJoinTokens(ctx, input?.roles)),

  /** Promote a node to manager (quorum-guard-free: promoting only adds votes). */
  promote: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => promoteNode(ctx, input.id)),

  /** Demote a manager to worker — refused when it would break quorum. */
  demote: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => demoteNode(ctx, input.id)),
});
