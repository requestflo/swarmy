import { TRPCError } from '@trpc/server';
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
