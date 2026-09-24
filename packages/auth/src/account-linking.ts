import { APIError } from 'better-auth/api';
import type { DB } from '@swarmy/db';
import { SOCIAL_PROVIDERS } from './config';

/**
 * Who may attach an identity-provider account to an existing swarmy user.
 *
 * Better Auth links implicitly: an OAuth sign-in whose email matches an
 * existing user (and whose IdP says `email_verified: true`) gets a new
 * `account` row on THAT user and a session for them. For the four instance
 * social providers that is the intended convenience. For an org SSO provider
 * (genericOAuth, registered by any org admin) it is an account takeover: org
 * B's admin points "their" IdP at a server they control, asserts org A
 * owner's email as verified, and signs in as org A's owner.
 *
 * The rule: an org SSO account may be created for a user only when the user
 * is brand new (this very sign-in created them), or is already a member of
 * that provider's org — the org's own directory speaking for its own people.
 * Enforced in `databaseHooks.account.create.before`, which sits under every
 * account-creating path (implicit link, explicit `/oauth2/link`, first login).
 */

/** How recently a user row must have been created to count as "this sign-in created them". */
export const NEW_USER_WINDOW_MS = 60_000;

/**
 * Provider ids an org SSO provider may never use: they name Better Auth's own
 * account kinds or an instance social provider. A genericOAuth provider with
 * such an id would share `account.providerId` with those rows, so its IdP
 * could answer with an existing account's `sub` and sign in as that user.
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  'credential',
  'email',
  'email-password',
  'magic-link',
  'magic_link',
  'passkey',
  'username',
  'anonymous',
  'phone-number',
  'siwe',
  ...SOCIAL_PROVIDERS,
];

export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.includes(providerId.trim().toLowerCase());
}

export type AccountLinkDecision = { allow: true } | { allow: false; reason: 'sso_link_not_member' };

/**
 * Pure: may an account on `providerId` be created for this user?
 *
 * @param input.ssoOrgId the org owning the org SSO provider with this id, or
 *   null when `providerId` is not an org SSO provider (credential, social, …).
 * @param input.userIsNew the user was created by this same sign-in.
 * @param input.isMemberOfSsoOrg the user is already a member of `ssoOrgId`.
 */
export function decideAccountLink(input: {
  ssoOrgId: string | null;
  userIsNew: boolean;
  isMemberOfSsoOrg: boolean;
}): AccountLinkDecision {
  if (!input.ssoOrgId) return { allow: true };
  if (input.userIsNew) return { allow: true };
  if (input.isMemberOfSsoOrg) return { allow: true };
  return { allow: false, reason: 'sso_link_not_member' };
}

/**
 * Pure: was this user created by the sign-in that is now creating its first
 * account? A missing row (not yet visible) counts as new; otherwise the user
 * must have no accounts at all and have been created moments ago.
 */
export function userLooksNew(
  user: { createdAt: Date } | null,
  existingAccounts: number,
  now: Date = new Date(),
): boolean {
  if (!user) return true;
  if (existingAccounts > 0) return false;
  return now.getTime() - user.createdAt.getTime() <= NEW_USER_WINDOW_MS;
}

export const SSO_LINK_REFUSED_MESSAGE =
  "This sign-in provider belongs to an organization you are not a member of, so it can't be linked to your existing account";

type LinkDb = Pick<DB, 'ssoProvider' | 'user' | 'account' | 'member'>;

/**
 * The `databaseHooks.account.create.before` guard. Throws (never returns
 * `false`): Better Auth's implicit-link path ignores a null link result and
 * would still mint the session, whereas a throw aborts it as
 * "unable to link account".
 */
export async function assertAccountLinkAllowed(
  db: LinkDb,
  account: { userId?: unknown; providerId?: unknown },
  now: Date = new Date(),
): Promise<void> {
  const userId = typeof account.userId === 'string' ? account.userId : null;
  const providerId = typeof account.providerId === 'string' ? account.providerId : null;
  if (!userId || !providerId) return;
  const sso = await db.ssoProvider.findUnique({ where: { providerId }, select: { orgId: true } });
  if (!sso) return;
  const [user, accounts, member] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    db.account.count({ where: { userId } }),
    db.member.findFirst({ where: { userId, organizationId: sso.orgId }, select: { id: true } }),
  ]);
  const decision = decideAccountLink({
    ssoOrgId: sso.orgId,
    userIsNew: userLooksNew(user, accounts, now),
    isMemberOfSsoOrg: member !== null,
  });
  if (decision.allow) return;
  throw new APIError('FORBIDDEN', { message: SSO_LINK_REFUSED_MESSAGE, code: 'SSO_LINK_NOT_MEMBER' });
}
