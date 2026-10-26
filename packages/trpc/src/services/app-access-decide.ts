/**
 * Who gets into a login-protected app (app-access.service.ts): the live
 * swarmy session behind an app cookie or login code, the app's org's account
 * walls (app-access-walls.ts), then ABAC `app.access` on the app's stack.
 *
 * Every refusal is audited as `authz.deny:app.access` (throttled to one row a
 * minute per person and host, so a refused browser retrying assets cannot
 * flood the log), with the reason; together with the `app.access.login` row
 * a sign-in writes, that is the Access tab's Recent sign-ins.
 */
import { displayEmail } from '@swarmy/auth';
import { decideAppPath, type AppPathPrincipal } from '@swarmy/core';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { decide, principalFromMember } from '../abac';
import { appAccessWall } from './app-access-walls';
import { appResource, appTarget, pathOf, type ProtectedRoute } from './app-access-route';
import { writeAudit } from './audit.service';

export interface Identity {
  uid: string;
  sid: string;
  email: string | null;
  name: string | null;
  sessionExpiresAt: Date;
  /** How the swarmy session signed in (`Session.signInMethod`); null before swarmy recorded it. */
  method: string | null;
}

/** The swarmy Better Auth session behind an id pair, if it is still live and fully signed in. */
export async function liveSession(db: DB, sid: string, uid: string, now: number): Promise<Identity | null> {
  const s = await db.session.findFirst({
    where: { id: sid, userId: uid },
    select: { expiresAt: true, mfaPending: true, signInMethod: true },
  });
  if (!s || s.mfaPending || s.expiresAt.getTime() <= now) return null;
  const u = await db.user.findUnique({ where: { id: uid }, select: { email: true, name: true } });
  if (!u) return null;
  return { uid, sid, email: displayEmail(u.email), name: u.name || null, sessionExpiresAt: s.expiresAt, method: s.signInMethod ?? null };
}

/** Why a signed-in person was refused, as the audit row and Recent sign-ins name it. */
export type DenyReason = 'not-member' | 'wall' | 'policy' | 'path' | 'rules';

export interface Decision {
  permit: boolean;
  groups: string[];
  policyId: string | null;
  member: boolean;
  /** The org's account wall refused this session (2FA owed, SSO only): its words. */
  wall?: string;
  reason?: DenyReason;
  /** Who they are in the app's org, for the route's path rules (members only). */
  who?: AppPathPrincipal;
}

export interface DecideDeps {
  db: DB;
  hub: Pick<AgentHub, 'liveInventory'>;
}

export async function decideAccess(deps: DecideDeps, route: ProtectedRoute, uid: string, sid: string): Promise<Decision> {
  const m = await deps.db.member.findFirst({
    where: { organizationId: route.orgId, userId: uid },
    select: { id: true, userId: true, role: true, attributes: true, createdAt: true },
  });
  if (!m) return { permit: false, groups: [], policyId: null, member: false, reason: 'not-member' };
  const role = m.role as 'owner' | 'admin' | 'member';
  const wall = await appAccessWall(deps.db, { uid, sid, orgId: route.orgId, role, memberSince: m.createdAt });
  if (wall) return { permit: false, groups: [], policyId: null, member: true, wall, reason: 'wall' };
  const principal = principalFromMember(route.orgId, m);
  const d = await decide({
    db: deps.db,
    orgId: route.orgId,
    principal,
    action: 'app.access',
    resource: appResource(deps.hub, route),
  });
  const permit = d.decision === 'permit';
  const groups = principal.groups ?? [];
  return {
    permit,
    groups,
    policyId: d.policyId,
    member: true,
    who: { memberId: m.id, role, groups },
    ...(permit ? {} : { reason: 'policy' as const }),
  };
}

/**
 * The route's path rules (`access.paths`) for one URI, after the app let
 * them in: null = admitted; otherwise the refusal to audit. A path that
 * cannot be read safely is `unreadable` (a 400, not a who-can-enter answer).
 */
export function pathRefusal(route: ProtectedRoute, uri: string, who: AppPathPrincipal | undefined): { reason: 'path' | 'rules' | 'unreadable'; path: string } | null {
  if (route.access?.paths === undefined) return null;
  const d = decideAppPath(route.access.paths, uri, who ?? { role: '', groups: [] });
  if (d.admit) return null;
  const path = pathOf(uri).slice(0, 200);
  return { reason: d.reason === 'unreadable-path' ? 'unreadable' : d.reason, path: d.rule ?? path };
}

const deniedAudit = new Map<string, number>();

/** Test hook (app-access.service `resetAppAccessState`). */
export function resetDenyThrottle(): void {
  deniedAudit.clear();
}

export function sweep(map: Map<string, number>, olderThan: number): void {
  if (map.size < 2000) return;
  for (const [k, t] of map) if (t < olderThan) map.delete(k);
}

export async function auditDenied(
  deps: DecideDeps & { now?: () => number },
  route: ProtectedRoute,
  uid: string,
  d: { policyId: string | null; reason?: DenyReason; path?: string },
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const key = `${route.orgId}|${uid}|${route.host}`;
  if ((deniedAudit.get(key) ?? 0) > now - 60_000) return;
  deniedAudit.set(key, now);
  sweep(deniedAudit, now - 60_000);
  const target = appTarget(route);
  await writeAudit(
    { db: deps.db, activeOrgId: route.orgId, user: { id: uid } },
    {
      action: 'authz.deny:app.access',
      targetType: target.type,
      targetId: target.id,
      metadata: { host: route.host, policyId: d.policyId, reason: d.reason ?? 'policy', ...(d.path ? { path: d.path } : {}) },
    },
  );
}
