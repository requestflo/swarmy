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
] as const;

export type Action = (typeof ACTIONS)[number];

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

/** The authenticated subject, derived from Better Auth identity + membership. */
export interface Principal {
  userId: string;
  orgId: string;
  roles: Role[];
  /** Free-form subject attribute bag (team, employment type, …) from Member.attributes. */
  attributes: Record<string, unknown>;
}

/** The target of an action, or `null` for collection/instance-scoped actions. */
export interface Resource {
  type: string; // "node" | "stack" | "service" | "org" | "setting" | ...
  id: string;
  orgId: string;
  labels: Record<string, unknown>;
  /** Optional ownership edges (member/team ids) for ReBAC-style policies. */
  ownerMemberId?: string | null;
  ownerTeamId?: string | null;
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
