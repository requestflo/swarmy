import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { isSsoOnly, readySsoProviders, signOutNonSsoSessions, storedSessionDecision } from './sso-only-gate';

/**
 * The org switch "Members sign in with SSO only" (`OrgSecurityPolicy.requireSso`,
 * next to "require 2FA"). Turning it on needs an SSO provider of this org that
 * can sign people in, refuses to sign out the admin turning it on, and signs
 * out everyone it now refuses. Audited both ways.
 */

export interface SsoOnlyView {
  on: boolean;
  /** This org's providers that can sign people in now; turning on needs one. */
  ready: Array<{ providerId: string; protocol: 'oidc' | 'saml'; displayName: string }>;
  /** Your current session would stay signed in with it on (SSO, or an owner on password + 2FA). */
  keepsYouSignedIn: boolean;
}

export async function getSsoOnly(ctx: OrgContext): Promise<SsoOnlyView> {
  const [on, ready, you] = await Promise.all([
    isSsoOnly(ctx.db, ctx.activeOrgId),
    readySsoProviders(ctx.db, ctx.activeOrgId),
    storedSessionDecision(ctx.db, { sessionId: ctx.session.id, orgId: ctx.activeOrgId, role: ctx.membership.role }),
  ]);
  return { on, ready, keepsYouSignedIn: you.ok };
}

function refuse(message: string, swarmyCode: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message, cause: { swarmyCode } });
}

export async function setSsoOnly(ctx: OrgContext, on: boolean): Promise<SsoOnlyView & { signedOut: number }> {
  const view = await getSsoOnly(ctx);
  if (on && view.ready.length === 0) {
    throw refuse(
      'Set up company sign-in first: no SSO provider of this workspace can sign people in yet.',
      'SSO_NOT_READY',
    );
  }
  if (on && !view.keepsYouSignedIn) {
    throw refuse(
      ctx.membership.role === 'owner'
        ? 'Sign in with your company SSO, or with your password and two-factor code, first: turning this on now would sign you out.'
        : 'Sign in with your company SSO first: turning this on now would sign you out.',
      'SSO_ONLY_LOCKOUT',
    );
  }
  await ctx.db.orgSecurityPolicy.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, requireSso: on },
    update: { requireSso: on },
  });
  const signedOut = on && !view.on ? await signOutNonSsoSessions(ctx.db, ctx.activeOrgId) : 0;
  await writeAudit(ctx, {
    action: 'security.ssoOnly.set',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { requireSso: on, providers: view.ready.map((p) => p.providerId), signedOut },
  });
  return { ...view, on, signedOut };
}

/**
 * Refuse removing or switching off this org's last ready SSO provider while
 * the switch is on: nobody but an owner could sign in.
 */
export async function assertSsoOnlyKeepsProvider(ctx: OrgContext, providerId: string): Promise<void> {
  if (!(await isSsoOnly(ctx.db, ctx.activeOrgId))) return;
  const others = (await readySsoProviders(ctx.db, ctx.activeOrgId)).filter((p) => p.providerId !== providerId);
  if (others.length > 0) return;
  throw refuse(
    'Members sign in with SSO only, and this is the last provider that can sign them in. Turn that off first.',
    'SSO_ONLY_LAST_PROVIDER',
  );
}
