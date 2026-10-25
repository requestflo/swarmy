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
  whoCanPolicy,
} from '../services/policies.service';
import { simulateInvitePolicy } from '../services/invite-preview.service';
import { SetPolicyInput } from '../services/policy-input';

/**
 * ABAC policy management. Reads are org-members; writes are admin-only and
 * audited. The seeded default policies preserve today's role behaviour and are
 * protected from deletion. `validate`/`simulate`/`schema` power the policy editor
 * and the "why can't X do Y?" simulator.
 */
export const policiesRouter = router({
  /** The governed action catalogue, for the UI policy builder. */
  listActions: orgProcedure.query(() => [...ACTIONS]),
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

  /**
   * The invite form's live preview: what a hypothetical invitee (a role, plus
   * operator on the apps the invite names) could deploy, restart, … under the
   * org's real rules. Read-only; it decides nothing, so it writes no audit row.
   */
  simulateInvite: adminProcedure
    .input(
      z.object({
        role: z.enum(['owner', 'admin', 'member']),
        stackNames: z.array(z.string().min(1).max(128)).max(20).default([]),
      }),
    )
    .query(({ ctx, input }) => simulateInvitePolicy(ctx, input)),


  /** Create (no id) or update a policy; REST POST/PUT /policies share the schema. */
  set: abacProcedure('policy.write')
    .input(SetPolicyInput)
    .mutation(({ ctx, input }) => setPolicy(ctx, input)),

  delete: abacProcedure('policy.write')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deletePolicy(ctx, input.id)),
});
