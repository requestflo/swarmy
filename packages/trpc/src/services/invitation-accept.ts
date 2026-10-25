import { TRPCError } from '@trpc/server';
import { displayEmail, inviteNeedsSso, needsAppGrant, redeemInvitation } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AuthedContext } from '../context';
import { setActiveOrg } from './active-org';
import { writeAudit } from './audit.service';
import { grantInviteApp } from './invite-grant';
import { inviteSsoError, sessionSignInMethod } from './invite-sso';
import type { InviteRole } from './invitations.service';

/**
 * The invitee's side of a single-use invitation: the public preview the login
 * page shows, and the idempotent accept it calls after any sign-in. An
 * app-scoped invite (`Invitation.stackName`) gives the new member `operator`
 * on that app, the same grant an app-scoped invite link gives.
 */

/** What an invite link shows before sign-in. */
export interface InvitationPreview {
  orgName: string;
  role: InviteRole;
  /** The invited address, when the invite named one. */
  email: string | null;
  expired: boolean;
  /** The one app the invite scopes them to; null = the whole org. */
  stackName: string | null;
  /** Accepted only through the org's own SSO (the invite's flag, or an SSO-only org). */
  requireSso: boolean;
}

/** Public preview of an invite link (the unguessable id is the credential). */
export async function invitationPreview(db: DB, id: string, now: Date = new Date()): Promise<InvitationPreview | null> {
  const row = await db.invitation.findFirst({
    where: { id, status: 'pending' },
    select: {
      role: true,
      email: true,
      expiresAt: true,
      stackName: true,
      requireSso: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  });
  if (!row) return null;
  return {
    orgName: row.organization.name,
    role: (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as InviteRole,
    email: displayEmail(row.email),
    expired: row.expiresAt.getTime() <= now.getTime(),
    stackName: row.stackName ?? null,
    requireSso: await inviteNeedsSso(db, { requireSso: row.requireSso, orgId: row.organizationId }),
  };
}

/**
 * Redeem an invite link for the signed-in user and activate its org. A
 * link-only invite works for any sign-in method; one that names an email
 * needs that address verified or carried by the SSO/social identity used.
 * Idempotent: when the sign-in hook already redeemed it (and granted its app),
 * the user's membership answers.
 */
export async function acceptInvitation(ctx: AuthedContext, id: string): Promise<{ orgId: string }> {
  const redeemed = await redeemInvitation(
    ctx.db,
    {
      invitationId: id,
      user: { id: ctx.user.id, email: ctx.user.email, emailVerified: ctx.user.emailVerified },
      signInMethod: await sessionSignInMethod(ctx),
    },
    (orgId, entry) => writeAudit({ db: ctx.db, activeOrgId: orgId, user: ctx.user }, entry),
  );
  if (!redeemed.ok && redeemed.reason === 'email_mismatch') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This invite is for ${redeemed.invitedEmail ?? 'a specific email address'}. Sign in with an SSO or social account that uses that address.`,
      cause: { swarmyCode: 'INVITE_EMAIL_MISMATCH' },
    });
  }
  if (!redeemed.ok && redeemed.reason === 'sso_required') throw inviteSsoError(redeemed.sso, redeemed.invitedEmail ?? null);
  if (needsAppGrant(redeemed)) await grantInviteApp(ctx, redeemed.orgId, redeemed.memberId, redeemed.stackName);
  let orgId = redeemed.ok ? redeemed.orgId : null;
  if (!orgId) {
    // Already redeemed (by the sign-in hook, or a second click): find the org.
    const inv = await ctx.db.invitation.findFirst({
      where: { id, status: 'accepted' },
      select: { organizationId: true },
    });
    const member = inv
      ? await ctx.db.member.findFirst({
          where: { organizationId: inv.organizationId, userId: ctx.user.id },
          select: { organizationId: true },
        })
      : null;
    if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'This invite link has expired or was revoked.' });
    orgId = member.organizationId;
  }
  await setActiveOrg(ctx, orgId);
  return { orgId };
}
