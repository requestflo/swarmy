import type { Principal, Relation, Resource } from './types';

/**
 * A ReBAC edge: a principal (member or team) holds a `relation` on a resource.
 * Mirrors the `ResourceGrant` DB row, but framework-agnostic so the engine and
 * its tests never touch Prisma.
 */
export interface GrantEdge {
  principalType: 'member' | 'team';
  principalId: string;
  resourceType: string;
  resourceId: string;
  relation: Relation;
}

/**
 * Compute the set of relations a principal holds on a single resource, given the
 * org's grant edges. A grant matches when:
 *   - it is a `member` grant for the principal's `memberId`, or
 *   - it is a `team` grant for one of the principal's `teamIds`,
 * and the grant's resource type+id match the resource.
 *
 * `owner` implies the lesser relations (`operator`, `viewer`); `operator` implies
 * `viewer`. This keeps policies simple ("requires viewer") while ownership grants
 * everything below it.
 */
export function resolveRelations(
  principal: Pick<Principal, 'memberId' | 'teamIds'>,
  resource: Pick<Resource, 'type' | 'id'>,
  grants: GrantEdge[],
): Relation[] {
  const memberId = principal.memberId ?? null;
  const teamIds = new Set(principal.teamIds ?? []);
  const direct = new Set<Relation>();

  for (const g of grants) {
    if (g.resourceType !== resource.type || g.resourceId !== resource.id) continue;
    if (g.principalType === 'member' && memberId && g.principalId === memberId) {
      direct.add(g.relation);
    } else if (g.principalType === 'team' && teamIds.has(g.principalId)) {
      direct.add(g.relation);
    }
  }

  return expandRelations(direct);
}

/** Apply relation implication: owner ⊇ operator ⊇ viewer. */
export function expandRelations(relations: Iterable<Relation>): Relation[] {
  const out = new Set<Relation>(relations);
  if (out.has('owner')) {
    out.add('operator');
    out.add('viewer');
  }
  if (out.has('operator')) out.add('viewer');
  return [...out];
}

/** Attach the principal's resolved relations to a resource for policy evaluation. */
export function withRelations(
  resource: Resource,
  principal: Pick<Principal, 'memberId' | 'teamIds'>,
  grants: GrantEdge[],
): Resource {
  return { ...resource, principalRelations: resolveRelations(principal, resource, grants) };
}
