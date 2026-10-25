import { isInviteLinkToken } from './invite-links';
import { needsAppGrant, redeemInvitation, type InviteAppGrant, type RedeemDb } from './invite-redeem';
import type { AuthAudit } from './provisioning';
import { findSsoInviteFor } from './sso-invites';

/**
 * Invite redemption at sign-in: the single-use invitation the login page
 * parked in the invite cookie, else, after an SSO sign-in, the pending SSO
 * invite of that provider's org naming the address the IdP vouched for. A
 * SAML assertion arrives without the cookie (a cross-site POST), so this is
 * what redeems SSO invites there (sso-invites.ts). Shareable `swi_…` links are
 * the login page's to redeem (`authConfig.acceptInvite`, which also grants the
 * app). Returns the org joined, if any.
 */
export async function redeemOnSignIn(
  db: RedeemDb,
  input: {
    /** The invite cookie's value. */
    inviteId: string | null;
    user: { id: string; email: string; emailVerified?: boolean | null };
    signInMethod: string | null;
    /** The org of the SSO provider this sign-in came through. */
    ssoOrgId: string | null;
    clearInviteCookie: () => void;
  },
  opts: { audit?: AuthAudit; grantInviteApp?: InviteAppGrant },
): Promise<string | null> {
  const cookieId = input.inviteId && !isInviteLinkToken(input.inviteId) ? input.inviteId : null;
  const id =
    cookieId ?? (input.ssoOrgId ? await findSsoInviteFor(db, { orgId: input.ssoOrgId, email: input.user.email }) : null);
  if (!id) return null;
  const res = await redeemInvitation(db, { invitationId: id, user: input.user, signInMethod: input.signInMethod }, opts.audit);
  if (needsAppGrant(res) && opts.grantInviteApp) {
    await opts
      .grantInviteApp(res.orgId, { memberId: res.memberId, userId: input.user.id, stackName: res.stackName, invitationId: id })
      .catch(() => {
        /* best-effort: they joined; an admin can add the grant */
      });
  }
  // A refusal keeps the cookie so the page can explain it (authConfig.acceptInvite answers with the reason).
  if (cookieId && (res.ok || res.reason === 'gone')) input.clearInviteCookie();
  return res.ok ? res.orgId : null;
}
