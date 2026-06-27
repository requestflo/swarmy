import { z } from 'zod';
import { ACTIONS } from '@swarmy/abac';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  deletePolicy,
  listPolicies,
  setPolicy,
  validatePolicy,
  simulatePolicy,
  policySchema,
} from '../services/policies.service';

/**
 * ABAC policy management. Reads are org-members; writes are admin-only and
 * audited. The seeded default policies preserve today's role behaviour and are
 * protected from deletion. `validate`/`simulate`/`schema` power the policy editor
 * and the "why can't X do Y?" simulator.
 */
export const policiesRouter = router({
  /** The governed action catalogue, for the UI policy builder. */
  listActions: orgProcedure.query(() => [...ACTIONS]),

  /** Action catalogue + the JSON policy-doc schema for the no-code builder. */
  schema: orgProcedure.query(() => policySchema()),

  list: orgProcedure.query(({ ctx }) => listPolicies(ctx)),

  /** Compile-only validation (no save) for validate-on-type in the editor. */
  validate: orgProcedure
    .input(z.object({ source: z.string() }))
    .query(({ input }) => validatePolicy(input.source)),

  /** Run a PARC request for the current user against live policies. */
  simulate: orgProcedure
    .input(
      z.object({
        action: z.string(),
        resourceType: z.enum(['node', 'service', 'stack']).optional(),
        resourceId: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) => simulatePolicy(ctx, input)),

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
