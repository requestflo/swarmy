import type { Action, GrantEdge, IPolicyEngine, Principal, ResourceInput } from '@swarmy/abac';
import type { DB } from '@swarmy/db';
import { decide, loadGrants, loadPolicyEngine, principalFromMember, type AccessResult } from './abac';

export interface WhoCanRow {
  memberId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: 'owner' | 'admin' | 'member';
  groups: string[];
  decision: 'permit' | 'deny';
  policyId: string | null;
  reasons: string[];
}

/**
 * "Who can do X on Y?" — every member of the org with their decision and the
 * deciding policy. Pure over the db (no request context, no audit), so the
 * policy simulator and a worker (e.g. the mesh NetBird group sync: one group
 * per app stack, `whoCan(db, orgId, 'mesh.connect', stackResource)`) share it.
 *
 * `hypothetical`: the resource is a description ("a service where env =
 * production"), not a row, so no grant names it. A member who holds grants on
 * resources of that type is then also judged as if it were each of those: a
 * ReBAC rule (operators deploy their resources) answers "can, where they hold
 * a grant", and the first reason says which grant.
 */
export async function whoCan(
  db: DB,
  orgId: string,
  action: Action,
  resource: ResourceInput | null,
  opts: { hypothetical?: boolean } = {},
): Promise<WhoCanRow[]> {
  const hypothetical = Boolean(opts.hypothetical && resource);
  const [engine, members, typeGrants] = await Promise.all([
    loadPolicyEngine(db, orgId),
    db.member.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        role: true,
        attributes: true,
        user: { select: { name: true, email: true } },
      },
    }),
    hypothetical && resource ? loadGrants(db, orgId, { type: resource.type }) : Promise.resolve([]),
  ]);
  const rows: WhoCanRow[] = [];
  for (const m of members) {
    const principal = principalFromMember(orgId, m);
    let d = await decide({ db, orgId, principal, action, resource, engine, ...(hypothetical ? { grants: [] } : {}) });
    if (d.decision === 'deny' && hypothetical && resource) {
      d = (await viaGrant({ db, orgId, principal, action, resource, engine, grants: typeGrants })) ?? d;
    }
    rows.push({
      memberId: m.id,
      userId: m.userId,
      name: m.user?.name ?? null,
      email: m.user?.email ?? null,
      role: principal.roles[0] as WhoCanRow['role'],
      groups: principal.groups ?? [],
      decision: d.decision,
      policyId: d.policyId,
      reasons: d.reasons,
    });
  }
  return rows;
}

/** The hypothetical resource taken as each resource of its type the principal holds a grant on. */
async function viaGrant(args: {
  db: DB;
  orgId: string;
  principal: Principal;
  action: Action;
  resource: ResourceInput;
  engine: IPolicyEngine;
  grants: GrantEdge[];
}): Promise<AccessResult | null> {
  const { principal } = args;
  const mine = args.grants.filter((g) =>
    g.principalType === 'member' ? g.principalId === principal.memberId : (principal.teamIds ?? []).includes(g.principalId),
  );
  for (const id of new Set(mine.map((g) => g.resourceId))) {
    const d = await decide({ ...args, resource: { ...args.resource, id }, grants: mine });
    if (d.decision !== 'permit') continue;
    const relations = [...new Set(mine.filter((g) => g.resourceId === id).map((g) => g.relation))].join('/');
    return { ...d, reasons: [`only where they hold a grant: ${relations} on ${args.resource.type} ${id}`, ...d.reasons] };
  }
  return null;
}
