import { z } from 'zod';
import { ACTIONS } from '@swarmy/abac';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  deletePolicy,
  listPolicies,
  setPolicy,
  validatePolicy,
  simulatePolicy,
  policySchema,
  whoCanPolicy,
  resetDefaultPolicies,
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
    .input(z.object({ source: z.string(), effect: z.enum(['permit', 'forbid']).optional() }))
    .query(({ input }) => validatePolicy(input.source, input.effect)),

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

  /**
   * "Who can do X on Y?" — every member's decision + the deciding rule. Needs
   * `member.write` (it lists every member's reach), i.e. admins by default.
   */
  whoCan: abacProcedure('member.write')
    .input(
      z.object({
        action: z.string(),
        resourceType: z.enum(['node', 'service', 'stack']).optional(),
        resourceId: z.string().optional(),
        env: z.string().max(64).optional(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    )
    .query(({ ctx, input }) => whoCanPolicy(ctx, input)),

  /** Re-seed the default rules (upgrade orgs persisted before the ABAC model). */
  resetDefaults: abacProcedure('policy.write').mutation(({ ctx }) => resetDefaultPolicies(ctx)),

  set: abacProcedure('policy.write')
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

  delete: abacProcedure('policy.write')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deletePolicy(ctx, input.id)),
});
