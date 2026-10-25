import { TRPCError } from '@trpc/server';
import { loadSsoProviders, parseSignInMethod, revokeUserTokens, ssoProviderReady, ssoSignInDecision, type SsoDecision } from '@swarmy/auth';
import type { DB } from '@swarmy/db';

/**
 * The tRPC side of "Members sign in with SSO only" (`@swarmy/auth`
 * sso-enforcement.ts). Sign-in itself is refused in Better Auth; this gate
 * covers every session that already exists: one minted before the switch was
 * turned on, or moved into the org some other way. Same decision, same words.
 */

type Role = 'owner' | 'admin' | 'member';

/** The org's SSO providers that can sign people in right now. */
export async function readySsoProviders(db: DB, orgId: string) {
  return (await loadSsoProviders(db))
    .filter((p) => p.orgId === orgId && ssoProviderReady(p))
    .map((p) => ({ providerId: p.providerId, protocol: p.protocol, displayName: p.displayName ?? p.providerId }));
}

/** Is the org's switch on? Test doubles without the model never are. */
export async function isSsoOnly(db: DB, orgId: string): Promise<boolean> {
  if (!(db as { orgSecurityPolicy?: unknown }).orgSecurityPolicy) return false;
  const row = await db.orgSecurityPolicy.findUnique({ where: { orgId }, select: { requireSso: true } });
  return row?.requireSso === true;
}

/** The decision for one stored session, as if the switch were on. */
export function decideStoredSession(
  s: { signInMethod: string | null; mfaVerifiedAt: Date | null },
  input: { orgId: string; role: Role; orgProviderIds: ReadonlySet<string> },
): SsoDecision {
  const signIn = parseSignInMethod(s.signInMethod);
  const own = signIn?.kind === 'sso' && signIn.providerId !== null && input.orgProviderIds.has(signIn.providerId);
  return ssoSignInDecision({
    enforced: true,
    signIn,
    ssoOrgId: own ? input.orgId : null,
    orgId: input.orgId,
    role: input.role,
    secondFactor: s.mfaVerifiedAt ? 'verified' : 'none',
  });
}

async function orgProviderIds(db: DB, orgId: string): Promise<Set<string>> {
  const rows = await db.ssoProvider.findMany({ where: { orgId, enabled: true }, select: { providerId: true } });
  return new Set(rows.map((r) => r.providerId));
}

/** How a stored session fares against an SSO-only org. */
export async function storedSessionDecision(db: DB, input: { sessionId: string; orgId: string; role: Role }): Promise<SsoDecision> {
  const row = await db.session.findUnique({
    where: { id: input.sessionId },
    select: { signInMethod: true, mfaVerifiedAt: true },
  });
  if (!row) return { ok: false, code: 'SSO_REQUIRED', message: 'Sign in again.' };
  return decideStoredSession(row, { ...input, orgProviderIds: await orgProviderIds(db, input.orgId) });
}

/**
 * The orgProcedure gate. Refuses (`swarmyCode: SSO_REQUIRED` or
 * `BREAK_GLASS_NEEDS_2FA`) a session that could not have signed in to this
 * org with the switch on. Contexts without a session row (API keys) skip it,
 * and so do test doubles without a member row's `createdAt` (as enforceOrgMfa).
 */
export async function enforceOrgSso(
  db: DB,
  input: { session: { id?: string }; orgId: string; role: Role; memberSince: Date | undefined },
): Promise<void> {
  if (!input.session.id || !input.memberSince || !(await isSsoOnly(db, input.orgId))) return;
  const d = await storedSessionDecision(db, { sessionId: input.session.id, orgId: input.orgId, role: input.role });
  if (!d.ok) throw new TRPCError({ code: 'FORBIDDEN', message: d.message, cause: { swarmyCode: d.code } });
}

/**
 * Turning the switch on signs out every session active in the org that it
 * now refuses (API tokens and OAuth grants minted from them too). Returns how
 * many people that touched.
 */
export async function signOutNonSsoSessions(db: DB, orgId: string, now: Date = new Date()): Promise<number> {
  const [sessions, members, providers] = await Promise.all([
    db.session.findMany({
      where: { activeOrganizationId: orgId, expiresAt: { gt: now } },
      select: { id: true, userId: true, signInMethod: true, mfaVerifiedAt: true },
    }),
    db.member.findMany({ where: { organizationId: orgId }, select: { userId: true, role: true } }),
    orgProviderIds(db, orgId),
  ]);
  const roles = new Map(members.map((m) => [m.userId, m.role as Role]));
  const people = new Set<string>();
  for (const s of sessions) {
    const role = roles.get(s.userId);
    if (!role || decideStoredSession(s, { orgId, role, orgProviderIds: providers }).ok) continue;
    await db.session.deleteMany({ where: { id: s.id } });
    await revokeUserTokens(db, s.userId, { sessionId: s.id, now });
    people.add(s.userId);
  }
  return people.size;
}
