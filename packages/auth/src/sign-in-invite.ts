import { findInviteLinkById, isInviteLinkToken } from './invite-links';
import { redeemInviteLink, type LinkRedeemDb } from './invite-link-redeem';
import { needsAppGrant, redeemInvitation, type InviteAppGrant, type RedeemDb, type RedeemResult } from './invite-redeem';
import type { AuthAudit } from './provisioning';
import type { BoundInvite } from './saml-invite';
import { findSsoInviteFor } from './sso-invites';

/**
 * Invite redemption at sign-in. In order:
 *  - at a SAML ACS, the invite the sign-in started from, bound to its
 *    AuthnRequest (saml-invite.ts): a single-use invitation or a shareable
 *    link, redeemed by the same rules as the login page's accept;
 *  - the single-use invitation the login page parked in the invite cookie;
 *  - after an SSO sign-in, the pending SSO invite of that provider's org
 *    naming the address the IdP vouched for (sso-invites.ts).
 * A shareable `swi_…` link in the cookie stays the login page's to redeem
 * (`authConfig.acceptInvite`), since the cookie is there on its return.
 * Returns the org joined, if any.
 */
export async function redeemOnSignIn(
  db: RedeemDb & Partial<Pick<LinkRedeemDb, 'inviteLink'>>,
  input: {
    /** The invite cookie's value. */
    inviteId: string | null;
    /** The invite bound to this SAML sign-in's AuthnRequest. */
    bound?: BoundInvite | null;
    user: { id: string; email: string; emailVerified?: boolean | null };
    signInMethod: string | null;
    /** The org of the SSO provider this sign-in came through. */
    ssoOrgId: string | null;
    clearInviteCookie: () => void;
  },
  opts: { audit?: AuthAudit; grantInviteApp?: InviteAppGrant },
): Promise<string | null> {
  const { bound, user, signInMethod } = input;
  let id: string | null = null;
  let res: RedeemResult;
  if (bound?.kind === 'link') {
    // findInviteLinkById is null without the table, so the link redeemer always has it.
    const link = await findInviteLinkById(db, bound.id);
    const r = link ? await redeemInviteLink(db as LinkRedeemDb, { link, user, signInMethod }, opts.audit) : null;
    if (!r?.ok) return null;
    id = bound.id;
    res = r;
  } else {
    const cookieId = input.inviteId && !isInviteLinkToken(input.inviteId) ? input.inviteId : null;
    id = (bound ? bound.id : cookieId) ?? (input.ssoOrgId ? await findSsoInviteFor(db, { orgId: input.ssoOrgId, email: user.email }) : null);
    if (!id) return null;
    res = await redeemInvitation(db, { invitationId: id, user, signInMethod }, opts.audit);
    // A refusal keeps the cookie so the page can explain it (authConfig.acceptInvite answers with the reason).
    if (id === cookieId && (res.ok || res.reason === 'gone')) input.clearInviteCookie();
  }
  if (needsAppGrant(res) && opts.grantInviteApp) {
    await opts
      .grantInviteApp(res.orgId, { memberId: res.memberId, userId: user.id, stackName: res.stackName, invitationId: id })
      .catch(() => {
        /* best-effort: they joined; an admin can add the grant */
      });
  }
  return res.ok ? res.orgId : null;
}
