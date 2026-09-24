import { z } from 'zod';
import { adminProcedure, orgProcedure, protectedProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  getSecurityPolicy,
  listMemberMfa,
  myMfaStatus,
  resetMemberTwoFactor,
  setSecurityPolicy,
} from '../services/security.service';
import { MAX_GRACE_DAYS } from '../services/mfa-policy';

/**
 * Account security (launch-blocker #7). Enrolment, the sign-in challenge,
 * backup codes and disable are Better Auth endpoints (`/api/auth/two-factor/*`,
 * the dashboard calls them through `authClient.twoFactor`); this router is the
 * swarmy side: the org "require 2FA" policy, each member's standing, and the
 * admin reset. `me` is a protectedProcedure on purpose: it must answer while
 * orgProcedure is refusing the session (pending challenge / past grace).
 */
export const securityRouter = router({
  me: protectedProcedure.query(({ ctx }) => myMfaStatus(ctx)),

  policy: router({
    get: orgProcedure.query(({ ctx }) => getSecurityPolicy(ctx.db, ctx.activeOrgId)),
    set: abacProcedure('authconfig.write')
      .input(
        z.object({
          require2fa: z.enum(['off', 'admins', 'all']).optional(),
          graceDays: z.number().int().min(0).max(MAX_GRACE_DAYS).optional(),
          trustIdpMfa: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => setSecurityPolicy(ctx, input)),
  }),

  members: adminProcedure.query(({ ctx }) => listMemberMfa(ctx)),

  /** Reset another member's 2FA (lost device). Signs them out everywhere. */
  resetMember: abacProcedure('member.write')
    .input(z.object({ memberId: z.string() }))
    .mutation(({ ctx, input }) => resetMemberTwoFactor(ctx, input.memberId)),
});
