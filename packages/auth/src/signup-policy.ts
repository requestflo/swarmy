import { APIError } from 'better-auth/api';
import type { DB } from '@swarmy/db';
import { isLinkInviteEmail } from './identity';
import { inviteLinkAdmits, isInviteLinkToken } from './invite-links';

/**
 * Who may create an account (and a new organization) on this controller.
 *
 * A self-hosted swarmy is invite-only by default in production: a stranger who
 * finds the public URL must not be able to register, mint an org, and from there
 * mint join tokens. Registration is allowed only when ANY of:
 *
 *   1. `SWARMY_ALLOW_SIGNUP=true` — explicit open registration;
 *   2. no user exists yet — first-run bootstrap (the controller seeds the owner
 *      in-process before it starts listening, so this window is closed on a real
 *      install before the port is reachable);
 *   3. `SWARMY_BOOTSTRAP=1` and the email is the installer's `ADMIN_EMAIL` — the
 *      in-process seed (apps/api/src/bootstrap/seed.ts) creates the owner through
 *      Better Auth's sign-up so it owns password hashing;
 *   4. the email has a pending, unexpired invitation AND the address is
 *      proven: verified (locally or asserted verified by the IdP), or carried
 *      by an SSO provider of the inviting org (see {@link inviteAdmits});
 *   5. the request carries an invite link (`swarmy_invite` cookie, set by the
 *      login page) naming a pending, unexpired invitation — or a shareable
 *      `swi_…` invite link with uses left (`invite-links.ts`) — that admits this
 *      person: a link-only invite admits whoever holds it (username, social,
 *      SSO — no email needed); an invite that names an email admits only that
 *      proven address, as in 4;
 *   6. the sign-up is an org SSO first login (`/oauth2/callback/<providerId>`)
 *      and that enabled provider auto-provisions (the default): the IdP is the
 *      org's own directory, so its people are admitted and join as members;
 *   7. a social sign-in (`/callback/<provider>`) whose provider-verified email
 *      is in that provider's `allowedDomains` (e.g. only @company.com Google
 *      accounts). Empty (the default) means an invite is required.
 *
 * Unset `SWARMY_ALLOW_SIGNUP` defaults to open outside production (so `bun dev`
 * keeps its sign-up form) and invite-only in production.
 */
export type SignupMode = 'open' | 'invite-only';

type Env = Record<string, string | undefined>;

export const INVITE_ONLY_MESSAGE =
  'Registration is invite-only on this swarmy — ask an admin to invite you';

export const ORG_CREATE_FORBIDDEN_MESSAGE =
  'Creating organizations is disabled on this swarmy — ask an admin to invite you';

/** The slice of the Prisma client the policy reads. */
export type SignupPolicyDb = Pick<DB, 'user' | 'organization' | 'invitation' | 'member'> &
  Partial<Pick<DB, 'ssoProvider' | 'inviteLink'>>;

/** How the account is being created (from the Better Auth request, when there is one). */
export interface SignupVia {
  /** Invitation id from the invite-link cookie. */
  inviteId?: string | null;
  /** The org SSO provider id when the path is `/oauth2/callback/<providerId>`. */
  ssoProviderId?: string | null;
  /** The installer's bootstrap username (no-email first admin). */
  username?: string | null;
  /** The account's email is verified (Better Auth `emailVerified`). */
  emailVerified?: boolean;
  /**
   * The org whose own SSO provider (`/oauth2/callback/<providerId>`) carries
   * this identity. That org's directory counts as proof of an address for ITS
   * invitations only; any other IdP (social, another org's SSO) must assert the
   * email as verified (`emailVerified`).
   */
  idpOrgId?: string | null;
  /** Social sign-up whose verified email domain the provider's allowedDomains accepts. */
  socialDomainAllowed?: boolean;
}

/**
 * Does this invitation admit this person? A link-only invite (placeholder
 * address) admits whoever holds the link. An invite naming an email admits
 * only an account with that address, proven either by verification (the
 * address was verified locally, or the IdP asserted it verified) or by an SSO
 * provider of the INVITING org carrying it (`idpOrgId === invitationOrgId`).
 * A typed-in, unverified email is not proof, and neither is an arbitrary IdP:
 * another org's SSO provider can assert any address it likes.
 */
export function inviteAdmits(
  invitationEmail: string,
  person: { email: string | null | undefined; emailVerified?: boolean; idpOrgId?: string | null },
  invitationOrgId?: string | null,
): boolean {
  if (isLinkInviteEmail(invitationEmail)) return true;
  const same = (person.email ?? '').trim().toLowerCase() === invitationEmail.trim().toLowerCase();
  if (!same) return false;
  if (person.emailVerified) return true;
  return Boolean(person.idpOrgId && invitationOrgId && person.idpOrgId === invitationOrgId);
}

/** Parse an `allowedDomains` setting ("company.com, corp.io") into lowercase domains. */
export function parseAllowedDomains(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
}

/** Is `email`'s domain one of `domains` (exact match; no subdomain wildcard)? */
export function emailDomainAllowed(email: string | null | undefined, domains: string[]): boolean {
  if (!email || domains.length === 0) return false;
  const at = email.lastIndexOf('@');
  return at > 0 && domains.includes(email.slice(at + 1).toLowerCase());
}

/** Does an org SSO provider admit new people on first login? (`metadata.autoProvision`, default on). */
export function ssoAutoProvisions(row: { enabled: boolean; metadata: unknown } | null | undefined): boolean {
  if (!row?.enabled) return false;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return meta.autoProvision !== false;
}

export function resolveSignupMode(env: Env = process.env): SignupMode {
  const raw = env.SWARMY_ALLOW_SIGNUP?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'open';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'invite-only';
  return env.NODE_ENV === 'production' ? 'invite-only' : 'open';
}

/** Whether `email` may create an account right now (see module doc for rules). */
export async function isSignupAllowed(
  db: SignupPolicyDb,
  email: string,
  env: Env = process.env,
  now: Date = new Date(),
  via: SignupVia = {},
): Promise<boolean> {
  if (resolveSignupMode(env) === 'open') return true;
  const normalized = email.trim().toLowerCase();
  if (env.SWARMY_BOOTSTRAP === '1') {
    if (env.ADMIN_EMAIL && env.ADMIN_EMAIL.trim().toLowerCase() === normalized) return true;
    const adminUser = env.ADMIN_USERNAME?.trim().toLowerCase();
    if (adminUser && via.username?.trim().toLowerCase() === adminUser) return true;
  }
  if ((await db.user.count()) === 0) return true;
  // Better Auth's organization plugin stores invitation emails lowercased.
  const person = { email: normalized, emailVerified: via.emailVerified, idpOrgId: via.idpOrgId };
  const invite = await db.invitation.findFirst({
    where: { email: normalized, status: 'pending', expiresAt: { gt: now } },
    select: { email: true, organizationId: true },
  });
  if (invite && inviteAdmits(invite.email, person, invite.organizationId)) return true;
  // A shareable invite link (`swi_…`) admits whoever holds it while it is
  // unexpired, unrevoked and has uses left.
  if (isInviteLinkToken(via.inviteId) && (await inviteLinkAdmits(db, via.inviteId, now))) return true;
  if (via.inviteId && !isInviteLinkToken(via.inviteId)) {
    const link = await db.invitation.findFirst({
      where: { id: via.inviteId, status: 'pending', expiresAt: { gt: now } },
      select: { email: true, organizationId: true },
    });
    if (link && inviteAdmits(link.email, person, link.organizationId)) return true;
  }
  if (via.socialDomainAllowed) return true;
  if (via.ssoProviderId && db.ssoProvider) {
    const row = await db.ssoProvider.findUnique({
      where: { providerId: via.ssoProviderId },
      select: { enabled: true, metadata: true },
    });
    if (ssoAutoProvisions(row)) return true;
  }
  return false;
}

/** Throwing variant for the Better Auth `user.create.before` hook. */
export async function assertSignupAllowed(
  db: SignupPolicyDb,
  email: string,
  env: Env = process.env,
  via: SignupVia = {},
): Promise<void> {
  if (await isSignupAllowed(db, email, env, new Date(), via)) return;
  throw new APIError('FORBIDDEN', { message: INVITE_ONLY_MESSAGE, code: 'SIGNUP_INVITE_ONLY' });
}

/**
 * Whether a signed-in user may create a new organization. Open registration
 * allows anyone; otherwise only the first-run bootstrap (no org exists yet) or an
 * instance admin (an owner of an existing org). Invited members join the
 * inviting org by accepting — they never need to create one.
 */
export async function canCreateOrganization(
  db: SignupPolicyDb,
  userId: string,
  env: Env = process.env,
): Promise<boolean> {
  if (resolveSignupMode(env) === 'open') return true;
  if ((await db.organization.count()) === 0) return true;
  const owner = await db.member.findFirst({
    where: { userId, role: 'owner' },
    select: { id: true },
  });
  return owner !== null;
}
