import { z } from 'zod';
import { adminProcedure, protectedProcedure, publicProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  acceptInviteLink,
  createInviteLink,
  INVITE_LINK_EXPIRIES,
  INVITE_LINK_ROLES,
  inviteLinkPreview,
  listInviteLinks,
  revokeInviteLink,
} from '../services/inviteLinks.service';

const token = z.string().regex(/^swi_[\w-]{1,160}$/);

/**
 * Shareable invite links (owner decision Q7) — People & access. Admins list,
 * mint and revoke; anyone with the link previews it; a signed-in person
 * accepts it (the login page does, after sign-up/sign-in).
 */
export const inviteLinksRouter = router({
  list: adminProcedure.query(({ ctx }) => listInviteLinks(ctx)),

  create: adminProcedure
    .input(
      z.object({
        role: z.enum(INVITE_LINK_ROLES),
        stackName: z.string().min(1).max(128).nullish(),
        expiry: z.enum(INVITE_LINK_EXPIRIES),
        maxUses: z.number().int().min(1).max(1000).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => createInviteLink(ctx, input)),

  revoke: abacProcedure('member.write')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => revokeInviteLink(ctx, input.id)),

  preview: publicProcedure.input(z.object({ token })).query(({ ctx, input }) => inviteLinkPreview(ctx.db, input.token)),

  accept: protectedProcedure.input(z.object({ token })).mutation(async ({ ctx, input }) => {
    const r = await acceptInviteLink(ctx, input.token);
    await ctx.auth.api.setActiveOrganization({ headers: ctx.reqHeaders, body: { organizationId: r.orgId } });
    return r;
  }),
});
