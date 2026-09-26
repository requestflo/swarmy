import { z } from 'zod';
import { authRegistry, resolveSignupMode, type SignupMode } from '@swarmy/auth';
import { instanceOwnerProcedure, orgProcedure, protectedProcedure, publicProcedure, router } from '../trpc';
import { listProviders, setProvider, signInOptions, type SignInOption } from '../services/authConfig.service';
import { acceptInvitation, invitationPreview, type InvitationPreview } from '../services/invitations.service';
import { isInviteLinkToken, type InviteLinkState } from '@swarmy/auth';
import { acceptInviteLink, inviteLinkPreview } from '../services/inviteLinks.service';

/** An invite link's preview: a single-use invitation, or a shareable `swi_…` link (its app + state too). */
export type AnyInvitePreview = InvitationPreview & { stackName?: string | null; state?: InviteLinkState };

/**
 * Auth-provider configuration. Reads are org-members; writes change
 * INSTANCE-WIDE rows (social providers, magic link, passkeys), so only the
 * instance owner (owner of the controller's org) may make them
 * (`instanceOwnerProcedure`). Audited (in the service), and each triggers an
 * `AuthRegistry.rebuild()` so a toggled provider goes live with no restart.
 */
export const authConfigRouter = router({
  /**
   * Unauthenticated: what the login page needs before anyone signs in. The
   * registration mode and the sign-in buttons (provider ids + labels) — never
   * provider secrets or org data.
   */
  publicConfig: publicProcedure.query(
    async ({ ctx }): Promise<{ signupMode: SignupMode; signIn: SignInOption[]; dashboardUrl: string | null }> => ({
      signupMode: resolveSignupMode(),
      signIn: await signInOptions(ctx.db),
      // Where the login page sends someone whose address was refused (INVALID_ORIGIN).
      dashboardUrl: process.env.CONTROLLER_PUBLIC_URL?.trim() || null,
    }),
  ),

  /** Unauthenticated: who an invite link is from, for the login page. The link id is the credential. */
  invitePreview: publicProcedure
    .input(z.object({ id: z.string().regex(/^[\w-]{1,160}$/) }))
    .query(async ({ ctx, input }): Promise<AnyInvitePreview | null> => {
      if (!isInviteLinkToken(input.id)) return invitationPreview(ctx.db, input.id);
      const p = await inviteLinkPreview(ctx.db, input.id);
      if (!p || p.state === 'revoked') return null;
      return { orgName: p.orgName, role: p.role, email: null, expired: p.state !== 'ok', stackName: p.stackName, state: p.state };
    }),

  /**
   * Redeem an invite link for the signed-in user (any sign-in method; no email
   * match needed) and make its org active. Idempotent: the sign-in hook
   * usually redeemed it already.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ id: z.string().regex(/^[\w-]{1,160}$/) }))
    .mutation(async ({ ctx, input }): Promise<{ orgId: string }> => {
      if (!isInviteLinkToken(input.id)) return acceptInvitation(ctx, input.id);
      // A shareable link: join (and get its app grant), then make the org active.
      const r = await acceptInviteLink(ctx, input.id);
      await ctx.auth.api.setActiveOrganization({ headers: ctx.reqHeaders, body: { organizationId: r.orgId } });
      return { orgId: r.orgId };
    }),

  listProviders: orgProcedure.query(({ ctx }) => listProviders(ctx)),

  setProvider: instanceOwnerProcedure
    .input(
      z.object({
        type: z.string(),
        enabled: z.boolean().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        settings: z.record(z.string(), z.string().max(500)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setProvider(ctx, input);
      // Atomically swap in a fresh Better Auth instance reflecting the new config.
      await authRegistry.rebuild();
      return result;
    }),
});
