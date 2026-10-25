import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { ResolvedSsoProvider } from './config';
import type { AuthAudit } from './provisioning';
import { parseSignInMethod } from './sso-enforcement';
import { sessionMayBeActiveIn, ssoOnlyOrgIds, type EnforceDb } from './sso-enforcement-hooks';

/**
 * The rest of "Members sign in with SSO only" inside Better Auth
 * (session creation is sso-enforcement-hooks.ts):
 *
 *  - switching a session into an SSO-only org (`/organization/set-active`) is
 *    refused unless that session could have signed in there;
 *  - an owner's break-glass sign-in (password + second factor) is audited.
 *    A password step the 2FA plugin let through on a trusted device still owes
 *    a code: the session is marked `mfaPending`, so the MFA wall asks for one
 *    before anything loads. Break-glass is password + 2FA, every time.
 */

const BREAK_GLASS_PATHS = [
  '/sign-in/email',
  '/sign-in/username',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
];

type PluginDb = EnforceDb & Required<Pick<EnforceDb, 'session' | 'member'>>;

export function swarmySsoEnforcement(db: PluginDb, opts: { sso: ResolvedSsoProvider[]; audit?: AuthAudit }): BetterAuthPlugin {
  const byId = new Map(opts.sso.map((p) => [p.providerId, p]));
  return {
    id: 'swarmy-sso-enforcement',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/organization/set-active',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { organizationId?: unknown };
            if (typeof body.organizationId !== 'string' || !body.organizationId) return;
            const live = await getSessionFromCtx(ctx).catch(() => null);
            if (!live) return;
            const row = await db.session.findFirst({
              where: { token: live.session.token },
              select: { signInMethod: true, mfaVerifiedAt: true },
            });
            const d = await sessionMayBeActiveIn(
              db,
              {
                orgId: body.organizationId,
                userId: live.user.id,
                signInMethod: row?.signInMethod,
                secondFactorVerified: Boolean(row?.mfaVerifiedAt),
              },
              byId,
            );
            if (!d.ok) throw new APIError('FORBIDDEN', { message: d.message, code: d.code });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => BREAK_GLASS_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            // A challenged password step has no session yet; an in-session code is a step-up.
            const created = ctx.context.newSession;
            const stepUp = !ctx.path?.startsWith('/sign-in/') && Boolean(ctx.context.session);
            if (!created || stepUp) return;
            const s = created.session as { token: string; activeOrganizationId?: string | null; signInMethod?: string | null };
            const kind = parseSignInMethod(s.signInMethod)?.kind;
            const orgId = s.activeOrganizationId;
            if ((kind !== 'password' && kind !== 'password_2fa') || !orgId) return;
            if (!(await ssoOnlyOrgIds(db, [orgId])).has(orgId)) return;
            const member = await db.member.findFirst({
              where: { organizationId: orgId, userId: created.user.id },
              select: { role: true },
            });
            if (member?.role !== 'owner') return;
            const secondFactor = kind === 'password_2fa' ? 'challenge' : 'in-session';
            if (kind === 'password') await db.session.updateMany({ where: { token: s.token }, data: { mfaPending: true } });
            await opts.audit?.(orgId, {
              action: 'auth.breakGlass.signIn',
              targetType: 'user',
              targetId: created.user.id,
              actorId: created.user.id,
              metadata: { method: s.signInMethod, secondFactor, ip: created.session.ipAddress ?? null },
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
