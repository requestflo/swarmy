/**
 * Pure MFA policy decisions (launch-blocker #7). No DB, no clock of its own —
 * callers pass `now` — so the org 2FA requirement and the terminal step-up are
 * unit-tested as plain functions (mfa-policy.test.ts).
 */

export type Require2fa = 'off' | 'admins' | 'all';
export const REQUIRE_2FA_VALUES: readonly Require2fa[] = ['off', 'admins', 'all'];

export interface SecurityPolicy {
  require2fa: Require2fa;
  /** Days a member has to enrol, from max(enforcedSince, joinedAt). */
  graceDays: number;
  /** When the requirement last went off → on. */
  enforcedSince: Date | null;
  /** SSO/social-only members are exempt (their IdP owns MFA). */
  trustIdpMfa: boolean;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  require2fa: 'off',
  graceDays: 7,
  enforcedSince: null,
  trustIdpMfa: true,
};

export const MAX_GRACE_DAYS = 30;
const DAY_MS = 86_400_000;

export type Role = 'owner' | 'admin' | 'member';

/**
 * A member's standing against the org's "require 2FA" policy.
 *  - `not_required`: policy off, or it doesn't cover this role.
 *  - `enrolled`: has a verified authenticator.
 *  - `exempt_sso`: signs in only via SSO/social and the org trusts IdP MFA.
 *  - `grace`: must enrol by `deadline`; full access until then.
 *  - `blocked`: past the deadline. `orgProcedure` refuses with
 *    TWO_FACTOR_ENROLMENT_REQUIRED; enrolment itself (Better Auth endpoints +
 *    `security.me`) stays reachable.
 */
export type TwoFactorStanding = 'not_required' | 'enrolled' | 'exempt_sso' | 'grace' | 'blocked';

export interface TwoFactorRequirementInput {
  policy: SecurityPolicy;
  role: Role;
  enrolled: boolean;
  /** No password account: every sign-in goes through an IdP. */
  ssoOnly: boolean;
  memberSince: Date;
  now: Date;
}

export function policyCoversRole(require2fa: Require2fa, role: Role): boolean {
  if (require2fa === 'all') return true;
  if (require2fa === 'admins') return role === 'owner' || role === 'admin';
  return false;
}

export function twoFactorRequirement(input: TwoFactorRequirementInput): {
  standing: TwoFactorStanding;
  deadline: Date | null;
} {
  const { policy, role, enrolled, ssoOnly, memberSince, now } = input;
  if (!policyCoversRole(policy.require2fa, role)) return { standing: 'not_required', deadline: null };
  if (enrolled) return { standing: 'enrolled', deadline: null };
  if (ssoOnly && policy.trustIdpMfa) return { standing: 'exempt_sso', deadline: null };
  // No enforcedSince (a row written before the column was set) counts from now:
  // never retroactively block someone with zero warning.
  const since = policy.enforcedSince ?? now;
  const start = Math.max(since.getTime(), memberSince.getTime());
  const grace = Math.min(Math.max(policy.graceDays, 0), MAX_GRACE_DAYS);
  const deadline = new Date(start + grace * DAY_MS);
  return { standing: now.getTime() < deadline.getTime() ? 'grace' : 'blocked', deadline };
}

/**
 * The `enforcedSince` to persist when the policy changes. Off → on starts the
 * grace clock; widening admins → all restarts it so newly-covered members get
 * a full grace period instead of being blocked on the spot; narrowing (or
 * re-saving) keeps the running clock; off clears it.
 */
export function nextEnforcedSince(prev: SecurityPolicy, next: Require2fa, now: Date): Date | null {
  if (next === 'off') return null;
  if (prev.require2fa === 'off' || !prev.enforcedSince) return now;
  if (prev.require2fa === 'admins' && next === 'all') return now;
  return prev.enforcedSince;
}

// ── Terminal step-up ────────────────────────────────────────────────────────

export const DEFAULT_MFA_MAX_AGE_MS = 15 * 60_000;
export const MIN_MFA_MAX_AGE_MS = 60_000;
export const MAX_MFA_MAX_AGE_MS = 12 * 60 * 60_000;

export type StepUpDecision =
  | { ok: true }
  | { ok: false; swarmyCode: 'MFA_ENROLMENT_REQUIRED' | 'MFA_STEP_UP_REQUIRED'; message: string };

/**
 * May this session open a shell now? With `requireMfa`, the session must have
 * passed a second factor (sign-in challenge, in-session TOTP/backup code, or a
 * passkey) within `mfaMaxAgeMs`. A user with no second factor cannot step up at
 * all — they are told to enrol, never silently let through — unless they sign
 * in only through an identity provider the org trusts for MFA (`idpOwnsMfa`):
 * people without a password (and often without email) are never walled.
 */
export function stepUpDecision(input: {
  requireMfa: boolean;
  mfaMaxAgeMs: number;
  enrolled: boolean;
  mfaVerifiedAt: Date | null;
  now: Date;
  /** SSO/social-only account and the org trusts IdP MFA. */
  idpOwnsMfa?: boolean;
}): StepUpDecision {
  if (!input.requireMfa) return { ok: true };
  if (!input.enrolled && input.idpOwnsMfa) return { ok: true };
  if (!input.enrolled) {
    return {
      ok: false,
      swarmyCode: 'MFA_ENROLMENT_REQUIRED',
      message: 'This terminal requires two-factor authentication. Set up an authenticator app first.',
    };
  }
  const age = input.mfaVerifiedAt ? input.now.getTime() - input.mfaVerifiedAt.getTime() : Infinity;
  if (age >= 0 && age <= input.mfaMaxAgeMs) return { ok: true };
  return {
    ok: false,
    swarmyCode: 'MFA_STEP_UP_REQUIRED',
    message: 'Confirm it is you: enter a code from your authenticator app.',
  };
}
