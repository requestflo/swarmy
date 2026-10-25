import { SAML_ACS_PREFIX, samlProviderIdFromPath } from './saml';

/**
 * "Members sign in with SSO only" (`OrgSecurityPolicy.requireSso`): which
 * sign-ins may produce a session that is active in an org. Pure; the Better
 * Auth hooks are sso-enforcement-hooks.ts, the orgProcedure gate is trpc's
 * services/sso-enforcement.service.ts. All three ask {@link ssoSignInDecision}.
 *
 * With it on, only the org's OWN SSO providers (OIDC or SAML) sign its people
 * in. Password, social, email links (magic link, verify-email auto sign-in)
 * and passkeys are refused, and another org's IdP doesn't count. Owners keep
 * one break-glass path: password plus a second factor, every use audited.
 */

export type SignInKind = 'sso' | 'password' | 'password_2fa' | 'social' | 'email_link' | 'passkey';

export interface SignIn {
  kind: SignInKind;
  /** The SSO / social provider id, when the path names one. */
  providerId: string | null;
}

/** Paths that answer a password sign-in's second-factor challenge. */
const SECOND_FACTOR_PATHS = ['/two-factor/verify-totp', '/two-factor/verify-backup-code', '/two-factor/verify-otp'];
const PASSWORD_PATHS = ['/sign-in/email', '/sign-in/username', '/sign-up/email'];

function param(path: string, prefix: string, value: unknown): string | null {
  if (typeof value === 'string' && value && !value.startsWith(':')) return value;
  const tail = path.slice(prefix.length);
  return tail && !tail.startsWith(':') ? tail : null;
}

/**
 * The sign-in a session-minting Better Auth path stands for. Null: not a
 * sign-in (a session rotated by enrolment or a password change).
 */
export function signInFromPath(
  path: string | undefined,
  params?: Record<string, unknown> | null,
  body?: Record<string, unknown> | null,
): SignIn | null {
  if (!path) return null;
  if (path.startsWith(SAML_ACS_PREFIX)) {
    const id = samlProviderIdFromPath(path, params);
    return id ? { kind: 'sso', providerId: id } : null;
  }
  if (path.startsWith('/oauth2/callback/')) {
    const id = param(path, '/oauth2/callback/', params?.providerId);
    return id ? { kind: 'sso', providerId: id } : null;
  }
  if (PASSWORD_PATHS.includes(path)) return { kind: 'password', providerId: null };
  if (SECOND_FACTOR_PATHS.includes(path)) return { kind: 'password_2fa', providerId: null };
  if (path.startsWith('/callback/')) return { kind: 'social', providerId: param(path, '/callback/', params?.id) };
  if (path === '/sign-in/social') {
    return { kind: 'social', providerId: typeof body?.provider === 'string' ? body.provider : null };
  }
  if (path.startsWith('/magic-link/verify') || path === '/verify-email') return { kind: 'email_link', providerId: null };
  if (path === '/sign-in/passkey') return { kind: 'passkey', providerId: null };
  return null;
}

/** What `Session.signInMethod` stores: `sso:<id>`, `social:<id>`, or the kind. */
export function signInMethod(s: SignIn): string {
  if ((s.kind === 'sso' || s.kind === 'social') && s.providerId) return `${s.kind}:${s.providerId}`;
  return s.kind;
}

const KINDS: readonly string[] = ['sso', 'password', 'password_2fa', 'social', 'email_link', 'passkey'];

/** `Session.signInMethod` back into a sign-in; null for a session from before the column. */
export function parseSignInMethod(method: string | null | undefined): SignIn | null {
  if (!method) return null;
  const at = method.indexOf(':');
  const kind = at < 0 ? method : method.slice(0, at);
  if (!KINDS.includes(kind)) return null;
  return { kind: kind as SignInKind, providerId: at < 0 ? null : method.slice(at + 1) || null };
}

export type SsoRefusal = 'SSO_REQUIRED' | 'BREAK_GLASS_NEEDS_2FA';

export type SsoDecision = { ok: true; breakGlass: boolean } | { ok: false; code: SsoRefusal; message: string };

export const SSO_REQUIRED_MESSAGE = 'This workspace signs in with SSO only. Use your company sign-in.';
export const BREAK_GLASS_NEEDS_2FA_MESSAGE =
  'This workspace signs in with SSO only. Owners can still use a password, but only with two-factor turned on.';

export interface SsoDecisionInput {
  /** The org has "Members sign in with SSO only" on. */
  enforced: boolean;
  /** How the session signed in; null = unknown (minted before swarmy recorded it). */
  signIn: SignIn | null;
  /** The org that owns `signIn.providerId` (SSO sign-ins only). */
  ssoOrgId: string | null;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  /**
   * The second factor behind a password sign-in: `verified` (this session
   * passed one), `will_challenge` (the password step of an enrolled account:
   * the 2FA plugin challenges next), or `none`.
   */
  secondFactor: 'verified' | 'will_challenge' | 'none';
}

const ALLOW: SsoDecision = { ok: true, breakGlass: false };

/** May this sign-in give a session that is active in `orgId`? */
export function ssoSignInDecision(i: SsoDecisionInput): SsoDecision {
  if (!i.enforced) return ALLOW;
  const kind = i.signIn?.kind;
  if (kind === 'sso' && i.ssoOrgId === i.orgId) return ALLOW;
  if (i.role === 'owner' && (kind === 'password' || kind === 'password_2fa')) {
    if (kind === 'password_2fa' || i.secondFactor !== 'none') return { ok: true, breakGlass: true };
    return { ok: false, code: 'BREAK_GLASS_NEEDS_2FA', message: BREAK_GLASS_NEEDS_2FA_MESSAGE };
  }
  return { ok: false, code: 'SSO_REQUIRED', message: SSO_REQUIRED_MESSAGE };
}

/**
 * Where a new session lands: the oldest membership whose org this sign-in may
 * be active in. With none, the refusal for the oldest (what the person is told).
 */
export function pickLandingOrg<M extends { orgId: string }>(
  memberships: readonly M[],
  decide: (m: M) => SsoDecision,
): { orgId: string; decision: SsoDecision } | { orgId: null; decision: SsoDecision | null } {
  let first: SsoDecision | null = null;
  for (const m of memberships) {
    const d = decide(m);
    if (d.ok) return { orgId: m.orgId, decision: d };
    first ??= d;
  }
  return { orgId: null, decision: first };
}
