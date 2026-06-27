import type { Principal, Resource, Role } from './types';
import type { GrantEdge } from './grants';
import { resolveRelations } from './grants';

/** Raw identity facts the controller already has after `orgProcedure`. */
export interface PrincipalInput {
  userId: string;
  orgId: string;
  role: Role;
  memberId?: string | null;
  teamIds?: string[];
  /** Member.attributes JSON bag (team/employment/etc.). */
  attributes?: Record<string, unknown> | null;
}

/**
 * Build the ABAC principal from identity facts. Roles become one attribute among
 * many; the attribute bag is merged with derived fields (memberId, teamIds) so
 * policies can match on either `roles` or arbitrary `attributes`.
 */
export function buildPrincipal(input: PrincipalInput): Principal {
  const attributes = { ...(input.attributes ?? {}) };
  const teamIds = input.teamIds ?? [];
  return {
    userId: input.userId,
    memberId: input.memberId ?? null,
    orgId: input.orgId,
    roles: [input.role],
    teamIds,
    attributes: {
      memberId: input.memberId ?? null,
      teamIds,
      ...attributes,
    },
  };
}

/** Raw resource row facts (the org-scoped target of an action). */
export interface ResourceInput {
  type: string;
  id: string;
  orgId: string;
  labels?: Record<string, unknown> | null;
  ownerMemberId?: string | null;
  ownerTeamId?: string | null;
}

/**
 * Build the ABAC resource entity from a row, resolving the current principal's
 * ReBAC relations from the supplied grant edges. Pass the org's grants (already
 * filtered to this resource type/id is fine — extra rows are ignored).
 */
export function buildResource(
  input: ResourceInput,
  principal: Pick<Principal, 'memberId' | 'teamIds'>,
  grants: GrantEdge[] = [],
): Resource {
  return {
    type: input.type,
    id: input.id,
    orgId: input.orgId,
    labels: input.labels ?? {},
    ownerMemberId: input.ownerMemberId ?? null,
    ownerTeamId: input.ownerTeamId ?? null,
    principalRelations: resolveRelations(principal, { type: input.type, id: input.id }, grants),
  };
}
