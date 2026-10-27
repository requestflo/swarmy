import type { DB } from '@swarmy/db';
import { isLinkInviteEmail, isPlaceholderEmail } from './identity';
import { parseSignInMethod, type SignIn } from './sso-enforcement';
import { ssoOnlyOrgIds } from './sso-enforcement-hooks';

/**
 * Invites that must be accepted with SSO (`Invitation.requireSso`,
 * `InviteLink.requireSso`), and every invite of an org that signs in with SSO
 * only. Such an invite is redeemed only by a session that signed in through
 * the INVITING org's own SSO provider:
 *  - an invite naming an email: the IdP's address must be that one;
 *  - a link (no email): the address must be at the provider's domain, when
 *    the provider names one.
 *
 * The SAML gap: the IdP's POST to the ACS is cross-site, so the browser leaves
 * the SameSite=Lax invite cookie behind. The invite a SAML sign-in started
 * from rides its AuthnRequest instead (saml-invite.ts), which is what admits a
 * new person on a link. After every SSO sign-in the hook also redeems the
 * pending SSO invite of that provider's org that names the address the IdP
 * just vouched for ({@link findSsoInviteFor}). OIDC needs neither: its
 * callback is a top-level GET, which carries the Lax cookie (Better Auth's
 * signed `state` cookie, checked there, is Lax too).
 */

export type InviteSsoRefusal = 'sso_required' | 'sso_email_mismatch' | 'sso_domain_mismatch';
export type InviteSsoDecision = { ok: true } | { ok: false; reason: InviteSsoRefusal };

type InvitesDb = Partial<Pick<DB, 'ssoProvider' | 'orgSecurityPolicy' | 'invitation'>>;

function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/** Pure: may this sign-in redeem an invite that must be accepted with SSO? */
export function ssoInviteDecision(input: {
  /** The invite's address; null (or a link's reserved placeholder) for a link. */
  invitedEmail: string | null;
  inviteOrgId: string;
  signIn: SignIn | null;
  /** The SSO provider the session signed in with: its org and domain. */
  provider: { orgId: string; domain: string | null } | null;
  /** The accepting account's address, as the IdP gave it. */
  email: string | null | undefined;
}): InviteSsoDecision {
  if (input.signIn?.kind !== 'sso' || !input.provider || input.provider.orgId !== input.inviteOrgId) {
    return { ok: false, reason: 'sso_required' };
  }
  const email = isPlaceholderEmail(input.email) ? null : (input.email ?? '').trim().toLowerCase();
  if (input.invitedEmail && !isLinkInviteEmail(input.invitedEmail)) {
    return email === input.invitedEmail.trim().toLowerCase() ? { ok: true } : { ok: false, reason: 'sso_email_mismatch' };
  }
  const domain = input.provider.domain?.trim().toLowerCase().replace(/^@/, '');
  if (domain && domainOf(email) !== domain) return { ok: false, reason: 'sso_domain_mismatch' };
  return { ok: true };
}

/** Does this invite have to be accepted with SSO (its own flag, or its org signs in with SSO only)? */
export async function inviteNeedsSso(db: InvitesDb, invite: { requireSso?: boolean | null; orgId: string }): Promise<boolean> {
  if (invite.requireSso) return true;
  return (await ssoOnlyOrgIds(db, [invite.orgId])).has(invite.orgId);
}

/** Check an SSO invite against the session accepting it (its `signInMethod` and address). */
export async function checkSsoInvite(
  db: InvitesDb,
  invite: { email: string | null; orgId: string },
  accept: { signInMethod: string | null | undefined; email: string | null | undefined },
): Promise<InviteSsoDecision> {
  const signIn = parseSignInMethod(accept.signInMethod);
  const row =
    signIn?.kind === 'sso' && signIn.providerId && db.ssoProvider
      ? await db.ssoProvider.findUnique({
          where: { providerId: signIn.providerId },
          select: { orgId: true, domain: true, enabled: true },
        })
      : null;
  return ssoInviteDecision({
    invitedEmail: invite.email,
    inviteOrgId: invite.orgId,
    signIn,
    provider: row?.enabled ? { orgId: row.orgId, domain: row.domain } : null,
    email: accept.email,
  });
}

/**
 * After an SSO sign-in into `orgId`: the newest pending invite of that org
 * naming this IdP-vouched address that must be accepted with SSO. No cookie
 * needed, which is what makes SSO invites work over SAML.
 */
export async function findSsoInviteFor(
  db: InvitesDb,
  input: { orgId: string; email: string | null | undefined },
  now: Date = new Date(),
): Promise<string | null> {
  if (!db.invitation || isPlaceholderEmail(input.email)) return null;
  const ssoOnly = (await ssoOnlyOrgIds(db, [input.orgId])).has(input.orgId);
  const row = await db.invitation.findFirst({
    where: {
      organizationId: input.orgId,
      email: input.email!.trim().toLowerCase(),
      status: 'pending',
      expiresAt: { gt: now },
      ...(ssoOnly ? {} : { requireSso: true }),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}
