import { TRPCError } from '@trpc/server';
import type { InviteSsoRefusal } from '@swarmy/auth';
import type { AuthedContext, OrgContext } from '../context';
import { readySsoProviders } from './sso-only-gate';

/**
 * The tRPC half of invites that must be accepted with SSO (`@swarmy/auth`
 * sso-invites.ts): minting one needs an SSO provider of the org that can sign
 * people in; accepting one reads how the accepting session signed in.
 */

/** Minting an SSO invite: refused while no provider of the org can sign people in. */
export async function assertCanInviteWithSso(ctx: OrgContext, requireSso: boolean | undefined): Promise<void> {
  if (!requireSso) return;
  if ((await readySsoProviders(ctx.db, ctx.activeOrgId)).length > 0) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Set up company sign-in first: no SSO provider of this workspace can sign people in yet.',
    cause: { swarmyCode: 'SSO_NOT_READY' },
  });
}

/** How the signed-in session got here (`Session.signInMethod`); null = unknown, which no SSO invite accepts. */
export async function sessionSignInMethod(ctx: AuthedContext): Promise<string | null> {
  if (!ctx.session?.id || !(ctx.db as { session?: unknown }).session) return null;
  const row = await ctx.db.session.findUnique({ where: { id: ctx.session.id }, select: { signInMethod: true } });
  return row?.signInMethod ?? null;
}

const MESSAGES: Record<InviteSsoRefusal, (invited: string | null) => string> = {
  sso_required: () => 'This invite must be accepted with your company sign-in. Sign out, then sign in with SSO to join.',
  sso_email_mismatch: (invited) =>
    `This invite is for ${invited ?? 'another address'}. Sign in with your company SSO as that address to join.`,
  sso_domain_mismatch: () => 'This invite is for people at your company. Sign in with SSO using your work address to join.',
};

/** The refusal the login page shows (`swarmyCode: INVITE_SSO_REQUIRED`). */
export function inviteSsoError(reason: InviteSsoRefusal, invitedEmail: string | null = null): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: MESSAGES[reason](invitedEmail),
    cause: { swarmyCode: 'INVITE_SSO_REQUIRED', reason },
  });
}
