import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { DB } from '@swarmy/db';

/**
 * Authenticator-app 2FA (launch-blocker #7).
 *
 * Two pieces:
 *
 *  1. Better Auth's `twoFactor` plugin: TOTP enrolment (`/two-factor/enable` →
 *     QR/URI + backup codes, then `/two-factor/verify-totp` confirms), the
 *     sign-in challenge after `/sign-in/email`, backup codes and disable.
 *
 *  2. `mfaAssurance`, swarmy's own after-hook that records on the `session` row
 *     WHEN it last passed a second factor (`mfaVerifiedAt`) and whether it still
 *     OWES one (`mfaPending`). The plugin only challenges password sign-ins; a
 *     2FA-enrolled user who arrives by magic link would otherwise skip the
 *     second factor they opted into, so those sessions are marked pending and
 *     `orgProcedure` refuses them (`MFA_CHALLENGE_REQUIRED`) until the user
 *     verifies a code in-session. Social and org SSO sign-ins (`/callback/*`,
 *     `/oauth2/callback/*`) are exempt: the IdP owns MFA for federated logins.
 *     2FA is optional per user; nothing here is an org requirement. The same `mfaVerifiedAt` is the step-up
 *     clock the terminal checks (`TerminalPolicy.requireMfa` + `mfaMaxAgeMs`).
 */

/** Paths whose success proves a second factor on the resulting session. */
export const MFA_VERIFY_PATHS = [
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
  // Passkeys are MFA-grade (possession + user verification). Listed so the
  // host-injected passkey plugin counts once it is installed.
  '/sign-in/passkey',
] as const;

/**
 * How a newly created session relates to MFA, from the path that minted it.
 *
 *  - `verified`: the request itself proved a second factor.
 *  - `pending`: a sign-in path that bypasses the plugin's challenge. The session
 *    owes a code if the user is enrolled.
 *  - `exempt`: social or org SSO. The IdP enforces MFA; swarmy does not double-challenge.
 *  - `none`: anything else (password sign-in, which the plugin challenged or a
 *    trusted device skipped; session rotation on credential changes).
 */
export type SessionAssurance = 'verified' | 'pending' | 'exempt' | 'none';

export function classifySessionPath(path: string | undefined): SessionAssurance {
  if (!path) return 'none';
  if ((MFA_VERIFY_PATHS as readonly string[]).includes(path)) return 'verified';
  if (path.startsWith('/oauth2/callback/')) return 'exempt';
  // Social sign-in (GitHub/Google/Microsoft/GitLab/OIDC) is exempt like org
  // SSO: the identity provider owns MFA, and swarmy never adds a wall on top.
  if (path.startsWith('/callback/')) return 'exempt';
  if (path === '/sign-in/social') return 'exempt';
  if (path.startsWith('/magic-link/verify')) return 'pending';
  return 'none';
}

/** Better Auth's plugin, configured the swarmy way. */
export function swarmyTwoFactor() {
  return twoFactor({
    issuer: process.env.SWARMY_TOTP_ISSUER ?? 'swarmy',
    // SSO / magic-link users have no password; they may still enrol. Password
    // is still demanded when a credential account exists.
    allowPasswordless: true,
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: 'encrypted' },
    // 10 minutes to finish the challenge after the password step.
    twoFactorCookieMaxAge: 600,
    accountLockout: {
      enabled: true,
      maxFailedAttempts: STEP_UP_LOCKOUT.maxFailedAttempts,
      durationSeconds: STEP_UP_LOCKOUT.durationMs / 1000,
    },
  });
}

/**
 * The plugin locks an account after repeated failed codes only on the SIGN-IN
 * challenge; an in-session verify (swarmy's step-up) has no budget beyond the
 * 3-per-10s rate limit. `mfaAssurance` applies the same budget to step-ups on
 * the same `two_factor` counters, so a stolen session cookie cannot grind codes.
 */
export const STEP_UP_LOCKOUT = { maxFailedAttempts: 10, durationMs: 900_000 } as const;

/**
 * Endpoints a session that still OWES its second factor (`mfaPending`) may not
 * call. `orgProcedure` walls off tRPC; these are the Better Auth routes that
 * would otherwise let a half-authenticated session (e.g. a magic link to a
 * 2FA-enrolled account) skip the factor: turn 2FA off or re-enrol it (with
 * `allowPasswordless` there is no password to ask), read the TOTP secret or
 * mint backup codes, change credentials or profile, attach another sign-in
 * method (social/SSO link, passkey registration — a passkey sign-in counts as
 * MFA-verified), manage orgs, or hand an OIDC relying party a code.
 * Verifying a code (`/two-factor/verify-*`), session reads and sign-out stay open.
 */
export const MFA_PENDING_BLOCKED_PATHS: readonly string[] = [
  '/two-factor/disable',
  '/two-factor/enable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
  '/two-factor/view-backup-codes',
  '/change-password',
  '/change-email',
  '/update-user',
  '/delete-user',
  '/set-password',
  '/link-social',
  '/unlink-account',
  '/oauth2/link',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/oauth2/authorize',
  '/oauth2/consent',
  '/oauth2/continue',
];

/** Org-plugin routes a pending session still needs (landing on its org). */
const MFA_PENDING_ORG_ALLOWED = new Set(['/organization/set-active', '/organization/list']);

/** Pure: is `path` refused while the live session owes its second factor? */
export function blockedWhileMfaPending(path: string | undefined): boolean {
  if (!path) return false;
  if (MFA_PENDING_BLOCKED_PATHS.includes(path)) return true;
  return path.startsWith('/organization/') && !MFA_PENDING_ORG_ALLOWED.has(path);
}

export const MFA_PENDING_MESSAGE = 'Enter your two-factor code to finish signing in first.';

/** Paths that verify a code against a LIVE session when one is present. */
const STEP_UP_PATHS = ['/two-factor/verify-totp', '/two-factor/verify-backup-code'];

/** Pure: next counters after one in-session attempt. */
export function nextStepUpCounters(
  current: { failedVerificationCount: number },
  ok: boolean,
  now: Date,
): { failedVerificationCount: number; lockedUntil: Date | null } | null {
  if (ok) return current.failedVerificationCount === 0 ? null : { failedVerificationCount: 0, lockedUntil: null };
  const failed = current.failedVerificationCount + 1;
  return {
    failedVerificationCount: failed,
    lockedUntil:
      failed >= STEP_UP_LOCKOUT.maxFailedAttempts ? new Date(now.getTime() + STEP_UP_LOCKOUT.durationMs) : null,
  };
}

function tokenFromReturned(returned: unknown): string | null {
  if (!returned || typeof returned !== 'object') return null;
  if (returned instanceof Error) return null;
  const token = (returned as { token?: unknown }).token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** swarmy's MFA-assurance bookkeeping plugin. See the module comment. */
export function mfaAssurance(db: DB): BetterAuthPlugin {
  return {
    id: 'swarmy-mfa-assurance',
    hooks: {
      before: [
        {
          // A half-authenticated session (mfaPending) reaches none of the
          // sensitive routes above until it verifies a code in-session.
          matcher: (ctx) => blockedWhileMfaPending(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const live = await getSessionFromCtx(ctx).catch(() => null);
            if (!live) return;
            const row = await db.session.findFirst({
              where: { token: live.session.token },
              select: { mfaPending: true },
            });
            if (row?.mfaPending) {
              throw new APIError('FORBIDDEN', { message: MFA_PENDING_MESSAGE, code: 'MFA_CHALLENGE_REQUIRED' });
            }
          }),
        },
        {
          matcher: (ctx) => STEP_UP_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const live = await getSessionFromCtx(ctx).catch(() => null);
            if (!live) return; // sign-in challenge: the plugin's own lockout applies
            const row = await db.twoFactor.findFirst({
              where: { userId: live.user.id },
              select: { lockedUntil: true },
            });
            if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
              throw new APIError('TOO_MANY_REQUESTS', {
                message: 'Too many wrong codes. Try again in 15 minutes.',
                code: 'ACCOUNT_TEMPORARILY_LOCKED',
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => STEP_UP_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const live = await getSessionFromCtx(ctx).catch(() => null);
            if (!live) return;
            const row = await db.twoFactor.findFirst({
              where: { userId: live.user.id },
              select: { id: true, failedVerificationCount: true },
            });
            if (!row) return;
            const ok = tokenFromReturned(ctx.context.returned) !== null;
            const next = nextStepUpCounters(row, ok, new Date());
            if (next) await db.twoFactor.update({ where: { id: row.id }, data: next });
          }),
        },
        {
          matcher: (ctx) => classifySessionPath(ctx.path) !== 'none',
          handler: createAuthMiddleware(async (ctx) => {
            const kind = classifySessionPath(ctx.path);
            if (kind === 'verified') {
              // Both the sign-in challenge (new session) and an in-session
              // step-up answer `{ token, user }`; an APIError means it failed.
              // On enrolment the plugin rotates the session (newSession) and
              // still answers with the OLD token, so prefer the new one.
              if (!tokenFromReturned(ctx.context.returned)) return;
              const token =
                ctx.context.newSession?.session.token ?? tokenFromReturned(ctx.context.returned)!;
              await db.session.updateMany({
                where: { token },
                data: { mfaVerifiedAt: new Date(), mfaPending: false },
              });
              return;
            }
            if (kind !== 'pending') return;
            const created = ctx.context.newSession;
            if (!created) return;
            const enrolled =
              (created.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled ??
              (
                await db.user.findUnique({
                  where: { id: created.user.id },
                  select: { twoFactorEnabled: true },
                })
              )?.twoFactorEnabled;
            if (!enrolled) return;
            await db.session.updateMany({
              where: { token: created.session.token },
              data: { mfaPending: true },
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
