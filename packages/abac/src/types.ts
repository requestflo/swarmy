/**
 * PARC decision model: Principal / Action / Resource / Context. A policy is
 * `effect (permit|forbid) when (action matches) and (principal matches) and
 * (resource matches) and (context matches)`. The engine evaluates an org's policy
 * set against a request and returns permit/deny + the matching policy id.
 */

export type Role = 'owner' | 'admin' | 'member';

/** The complete catalogue of governed actions. Single registry: every
 * `abacProcedure(action)` must use a value from here, and every action should be
 * covered by the default policy set + this enum. */
export const ACTIONS = [
  'node.read',
  'node.drain',
  'node.remove',
  'node.setLabels',
  'service.read',
  'service.deploy',
  'service.scale',
  'service.restart',
  'service.remove',
  'stack.read',
  'stack.deploy',
  'stack.remove',
  'ingress.read',
  'ingress.write',
  'token.create',
  'token.revoke',
  'policy.read',
  'policy.write',
  'member.read',
  'member.write',
  'authconfig.read',
  'authconfig.write',
  // Web terminal / SSH proxy (epic #11). `terminal.open` governs opening an
  // interactive shell (container exec OR node shell) — the highest-risk action.
  'terminal.open',
] as const;

export type Action = (typeof ACTIONS)[number];

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

/** A ReBAC relation a principal holds on a resource (from ResourceGrant edges). */
export type Relation = 'owner' | 'operator' | 'viewer';

/** The authenticated subject, derived from Better Auth identity + membership. */
export interface Principal {
  userId: string;
  /** This member's `Member.id` (used to match member→resource grants). */
  memberId?: string | null;
  orgId: string;
  roles: Role[];
  /** Team ids the principal belongs to (used to match team→resource grants). */
  teamIds?: string[];
  /** Free-form subject attribute bag (team, employment type, …) from Member.attributes. */
  attributes: Record<string, unknown>;
}

/** The target of an action, or `null` for collection/instance-scoped actions. */
export interface Resource {
  type: string; // "node" | "stack" | "service" | "org" | "setting" | ...
  id: string;
  orgId: string;
  labels: Record<string, unknown>;
  /** Optional direct ownership edges (member/team ids) for ReBAC-style policies. */
  ownerMemberId?: string | null;
  ownerTeamId?: string | null;
  /**
   * Relations the *current* principal holds on this resource, resolved from
   * `ResourceGrant` edges (member or team grants). Lets policies match on
   * "principal is an operator/owner/viewer of this resource".
   */
  principalRelations?: Relation[];
}

/** Ambient request facts (time, ip, dryRun) policies may match on. */
export interface DecisionContext {
  now: Date;
  ip?: string | null;
  userAgent?: string | null;
  dryRun?: boolean;
}

export interface AuthzRequest {
  principal: Principal;
  action: Action;
  resource?: Resource | null;
  context?: Partial<DecisionContext>;
}

export type Effect = 'permit' | 'forbid';

/** A stored policy, as loaded from the DB and compiled by the engine. */
export interface PolicyInput {
  id: string;
  name: string;
  effect: Effect;
  /** JSON policy source (the predicate document). */
  source: string;
  priority: number;
  enabled: boolean;
}

export interface Decision {
  decision: 'permit' | 'deny';
  /** id of the deciding policy, when one matched. */
  policyId: string | null;
  reasons: string[];
}
