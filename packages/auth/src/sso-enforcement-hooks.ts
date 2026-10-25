import { APIError } from 'better-auth/api';
import type { DB } from '@swarmy/db';
import type { ResolvedSsoProvider } from './config';
import type { AuthAudit } from './provisioning';
import {
  parseSignInMethod,
  pickLandingOrg,
  signInFromPath,
  signInMethod,
  ssoSignInDecision,
  type SignIn,
  type SsoDecision,
} from './sso-enforcement';

/**
 * The session-creation half of "Members sign in with SSO only"
 * (sso-enforcement.ts): every new session records how it signed in
 * (`Session.signInMethod`), lands in the oldest org that sign-in may be active
 * in, and is refused outright when there is none. Runs as Better Auth's
 * `session.create.before`, so no sign-in path (password, social, SSO, email
 * link, passkey, the 2FA challenge) gets around it.
 */

export type EnforceDb = Partial<Pick<DB, 'member' | 'orgSecurityPolicy' | 'user' | 'session' | 'ssoProvider'>>;

type Role = 'owner' | 'admin' | 'member';

/** Which of these orgs have "Members sign in with SSO only" on. */
export async function ssoOnlyOrgIds(db: EnforceDb, orgIds: string[]): Promise<Set<string>> {
  if (!db.orgSecurityPolicy || orgIds.length === 0) return new Set();
  const rows = await db.orgSecurityPolicy.findMany({
    where: { orgId: { in: orgIds }, requireSso: true },
    select: { orgId: true },
  });
  return new Set(rows.map((r) => r.orgId));
}

/** The org that owns an SSO provider id (from the live config, else the table). */
export async function ssoOrgOf(db: EnforceDb, providerId: string | null, byId?: Map<string, ResolvedSsoProvider>): Promise<string | null> {
  if (!providerId) return null;
  const known = byId?.get(providerId);
  if (known) return known.orgId;
  if (byId || !db.ssoProvider) return null;
  const row = await db.ssoProvider.findUnique({ where: { providerId }, select: { orgId: true, enabled: true } });
  return row?.enabled ? row.orgId : null;
}

interface HookCtx {
  path?: string;
  params?: Record<string, unknown> | null;
  body?: unknown;
  context?: { session?: { session?: { signInMethod?: string | null } | null } | null };
}

type NewSession = { userId: string; activeOrganizationId?: string | null; signInMethod?: string | null } & Record<string, unknown>;

/** Better Auth `databaseHooks.session.create.before`. */
export function sessionCreateBefore(db: EnforceDb, byId: Map<string, ResolvedSsoProvider>, audit?: AuthAudit) {
  return async (session: NewSession, raw?: unknown): Promise<{ data: NewSession } | void> => {
    const ctx = (raw ?? {}) as HookCtx;
    const live = ctx.context?.session?.session ?? null;
    const found = signInFromPath(ctx.path, ctx.params, ctx.body as Record<string, unknown> | null);
    // A code answered on a live session is enrolment, not a sign-in.
    const signIn = found && !(found.kind === 'password_2fa' && live) ? found : null;
    // Rotations keep how the session they replace signed in.
    const method = signIn ? signInMethod(signIn) : (session.signInMethod ?? live?.signInMethod ?? null);
    const data: NewSession = { ...session, signInMethod: method };
    if (session.activeOrganizationId || !db.member) return { data };
    const memberships = (
      await db.member.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'asc' },
        select: { organizationId: true, role: true },
      })
    ).map((m) => ({ orgId: m.organizationId, role: m.role as Role }));
    if (memberships.length === 0) return { data };
    const enforced = await ssoOnlyOrgIds(db, memberships.map((m) => m.orgId));
    const judged = signIn ?? parseSignInMethod(method);
    const ssoOrgId = judged?.kind === 'sso' ? await ssoOrgOf(db, judged.providerId, byId) : null;
    const enrolled = await twoFactorOn(db, session.userId, judged, enforced, memberships);
    const pick = pickLandingOrg(memberships, (m) =>
      ssoSignInDecision({
        enforced: enforced.has(m.orgId),
        signIn: judged,
        ssoOrgId,
        orgId: m.orgId,
        role: m.role,
        secondFactor: enrolled ? 'will_challenge' : 'none',
      }),
    );
    if (pick.orgId) return { data: { ...data, activeOrganizationId: pick.orgId } };
    // Not a sign-in (a credential change): land as before; orgProcedure judges it.
    if (!signIn || !pick.decision || pick.decision.ok) return { data: { ...data, activeOrganizationId: memberships[0]!.orgId } };
    await refuse(audit, memberships[0]!.orgId, session.userId, method, pick.decision);
  };
}

/** Only an owner's password step can lean on 2FA; skip the lookup otherwise. */
async function twoFactorOn(
  db: EnforceDb,
  userId: string,
  signIn: SignIn | null,
  enforced: Set<string>,
  memberships: Array<{ orgId: string; role: Role }>,
): Promise<boolean> {
  if (signIn?.kind !== 'password' || !db.user) return false;
  if (!memberships.some((m) => m.role === 'owner' && enforced.has(m.orgId))) return false;
  const user = await db.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
  return user?.twoFactorEnabled === true;
}

async function refuse(audit: AuthAudit | undefined, orgId: string, userId: string, method: string | null, d: SsoDecision): Promise<never> {
  const code = d.ok ? 'SSO_REQUIRED' : d.code;
  await audit?.(orgId, {
    action: 'auth.signIn.ssoRequired',
    targetType: 'user',
    targetId: userId,
    actorId: userId,
    metadata: { method, reason: code },
  }).catch(() => {
    /* best-effort: the refusal stands */
  });
  throw new APIError('FORBIDDEN', { message: d.ok ? '' : d.message, code });
}

/**
 * May a session that signed in this way be active in `orgId`? For the paths
 * that move a session into an org after it exists (invite redemption, SSO
 * first login, switching orgs). `secondFactorVerified`: this session passed one.
 */
export async function sessionMayBeActiveIn(
  db: EnforceDb,
  input: { orgId: string; userId: string; signInMethod: string | null | undefined; secondFactorVerified: boolean },
  byId?: Map<string, ResolvedSsoProvider>,
): Promise<SsoDecision> {
  const enforced = (await ssoOnlyOrgIds(db, [input.orgId])).has(input.orgId);
  if (!enforced) return { ok: true, breakGlass: false };
  const signIn = parseSignInMethod(input.signInMethod);
  const member = await db.member?.findFirst({
    where: { organizationId: input.orgId, userId: input.userId },
    select: { role: true },
  });
  return ssoSignInDecision({
    enforced,
    signIn,
    ssoOrgId: signIn?.kind === 'sso' ? await ssoOrgOf(db, signIn.providerId, byId) : null,
    orgId: input.orgId,
    role: (member?.role ?? 'member') as Role,
    secondFactor: input.secondFactorVerified ? 'verified' : 'none',
  });
}
