import { z } from 'zod';
import { ACTIONS } from '@swarmy/abac';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { deletePolicy, listPolicies, setPolicy } from '../services/policies.service';

/**
 * ABAC policy management. Reads are org-members; writes are admin-only and
 * audited. The seeded default policies preserve today's role behaviour and are
 * protected from deletion.
 */
export const policiesRouter = router({
  /** The governed action catalogue, for the UI policy builder. */
  listActions: orgProcedure.query(() => [...ACTIONS]),

  list: orgProcedure.query(({ ctx }) => listPolicies(ctx)),

  set: adminProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        effect: z.enum(['permit', 'forbid']),
        source: z.string().min(2),
        priority: z.number().int().min(0).max(1000).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setPolicy(ctx, input)),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deletePolicy(ctx, input.id)),
});
