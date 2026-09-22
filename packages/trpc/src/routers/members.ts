import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  listMembers,
  setMemberAttributes,
  listGrants,
  createGrant,
  deleteGrant,
} from '../services/members.service';
import {
  inviteMember,
  listInvitations,
  regenerateInvitation,
  revokeInvitation,
} from '../services/invitations.service';

/**
 * Org member attribute management + ReBAC grants (org admin). Attributes feed the
 * ABAC principal; grants (`ResourceGrant`) feed the engine's relation matching.
 * Reads are org-members; writes are admin-only and audited.
 */
export const membersRouter = router({
  list: orgProcedure.query(({ ctx }) => listMembers(ctx)),

  setAttributes: adminProcedure
    .input(
      z.object({
        memberId: z.string(),
        attributes: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(({ ctx, input }) => setMemberAttributes(ctx, input)),

  // ── ReBAC grants ──
  listGrants: orgProcedure.query(({ ctx }) => listGrants(ctx)),

  createGrant: adminProcedure
    .input(
      z.object({
        principalType: z.enum(['member', 'team']),
        principalId: z.string(),
        resourceType: z.enum(['node', 'service', 'stack']),
        resourceId: z.string(),
        relation: z.enum(['owner', 'operator', 'viewer']),
      }),
    )
    .mutation(({ ctx, input }) => createGrant(ctx, input)),

  deleteGrant: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteGrant(ctx, input.id)),

  // ── Invitations (copy-a-link; no mailer on a self-hosted controller) ──
  listInvitations: adminProcedure.query(({ ctx }) => listInvitations(ctx)),

  invite: adminProcedure
    .input(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        role: z.enum(['owner', 'admin', 'member']),
      }),
    )
    .mutation(({ ctx, input }) => inviteMember(ctx, input)),

  revokeInvitation: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeInvitation(ctx, input.id)),

  regenerateInvitation: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => regenerateInvitation(ctx, input.id)),
});
