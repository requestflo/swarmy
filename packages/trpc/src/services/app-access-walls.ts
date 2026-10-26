import { TRPCError } from '@trpc/server';
import { parseSignInMethod } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { enforceOrgMfa } from './security.service';
import { enforceOrgSso } from './sso-only-gate';

type Role = 'owner' | 'admin' | 'member';

/**
 * The orgProcedure account walls, for a swarmy session reaching one of an
 * org's login-protected apps (app-access.service.ts): a session the dashboard
 * refuses for that org — it owes a second factor, the org's 2FA grace is over,
 * or the org signs in with SSO only — gets none of its apps either.
 *
 * App access judges the APP's org, not the session's active one, so without
 * this a member of two orgs could open an SSO-only org's apps with a password
 * session that landed in the other. Returns the refusal's words, or null.
 */
export async function appAccessWall(
  db: DB,
  input: { uid: string; sid: string; orgId: string; role: Role; memberSince: Date },
): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: input.uid }, select: { twoFactorEnabled: true } });
  const at = { orgId: input.orgId, role: input.role, memberSince: input.memberSince, session: { id: input.sid } };
  try {
    await enforceOrgMfa(db, { ...at, user: { id: input.uid, twoFactorEnabled: user?.twoFactorEnabled } });
    await enforceOrgSso(db, at);
    return null;
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'FORBIDDEN') return e.message;
    throw e;
  }
}

export const APP_SSO_ONLY_MESSAGE =
  "This app only lets in people who signed in with your organisation's single sign-on. Sign out of swarmy, then sign in with your company account.";

/**
 * The app's own sign-in toggle (`access.signIn: 'sso'`): the session must have
 * signed in with one of the app's org's enabled SSO providers. No owner
 * break-glass here (the dashboard keeps that); a session swarmy never
 * recorded the method of is refused. Returns the refusal's words, or null.
 */
export async function appSignInWall(db: DB, input: { sid: string; orgId: string }): Promise<string | null> {
  const s = await db.session.findUnique({ where: { id: input.sid }, select: { signInMethod: true } });
  const signIn = parseSignInMethod(s?.signInMethod);
  if (signIn?.kind !== 'sso' || !signIn.providerId) return APP_SSO_ONLY_MESSAGE;
  const own = await db.ssoProvider.count({ where: { orgId: input.orgId, providerId: signIn.providerId, enabled: true } });
  return own > 0 ? null : APP_SSO_ONLY_MESSAGE;
}
