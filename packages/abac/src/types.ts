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
  // Destructive-action sweep (owner decision 2026-09-24). Every one of these is
  // owner/admin-only in the seeded defaults (the `*` superuser permits cover
  // them; no member policy names them), so an org — including one whose
  // defaults were persisted before these existed — never locks its admins out.
  /** Destroy managed data: DB/cache/search/vector/queue teardown, bucket/key delete, store disable. */
  'data.destroy',
  /** Restore over live data: volume/DB/cache/search snapshot restore, controller/mirror restore. */
  'data.restore',
  /** Confirm a managed-DB failover that may lose the last writes (the data-loss window). */
  'data.failover',
  /** Remove a backup target or the offsite mirror (loses recoverability, not data). */
  'backup.remove',
  /** Delete or prune a secret/config family (Docker secrets/configs). */
  'secret.delete',
  /** Remove a geo-DNS zone or record. */
  'dns.remove',
  /** Remove edge infrastructure beyond a route: the Cloudflare tunnel. */
  'ingress.remove',
  /** Remove a git repo / CI connection (and, later, a git app). */
  'cicd.remove',
  // Attribute-based access (2026-09-24). Evaluated against the resource's
  // attributes (env, labels, type) so "members deploy outside production" is one
  // rule. `service.configure` is member-permitted outside production by the
  // seeded defaults; the rest are owner/admin-only until an org grants them.
  /** Change a running service's spec (env, ports, image, scale-to-zero). */
  'service.configure',
  /** Read secret material back out (unlock key, webhook secret). */
  'secrets.read',
  /** Join a stack's mesh network from a client (NetBird group sync). */
  'mesh.connect',
  // Database studio (epic developer-platform §3). Reading rows is data access
  // (member-permitted outside production); writing rows needs `data.write`
  // (owner/admin-only until granted). DDL / DELETE-without-WHERE rides the
  // existing `data.destroy`.
  /** Browse tables and run read-only queries in the database studio. */
  'data.read',
  /** Insert, update or delete rows (or run a write statement) in the database studio. */
  'data.write',
  // Auth for your apps (epic developer-platform §2). "Protect my app": who may
  // sign in to an app behind the swarmy identity-aware proxy, evaluated on the
  // app's STACK (its env/labels) for every request. Owner/admin-only in the
  // seeded defaults (the `*` superuser permits); an org grants members, groups
  // or SSO groups explicitly — the app's Access panel writes those rules.
  /** Enter a login-protected app (the edge forward-auth check). */
  'app.access',
  // AI gateway (epic developer-platform §11). Evaluated on the MODEL (resource
  // type `aiModel`, id = the alias or model id, labels `swarmy.ai.provider`,
  // `swarmy.ai.alias`, `swarmy.ai.cost` free|paid) for the member who minted
  // the calling key, and for the member running the playground. Members may
  // use every model by default; an org narrows it with a forbid rule.
  /** Call a model through the AI gateway. */
  'ai.use',
  // Email service (epic developer-platform §8). Owner/admin-only in the seeded
  // defaults (the `*` superuser permits); an org grants others explicitly.
  /** Configure the email service: switch, sending domains, relays, credentials, templates, suppressions. */
  'email.write',
  /** Send a test email from the Email page. */
  'email.send',
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
  /**
   * Groups the principal belongs to: `Member.attributes.groups` (SSO group
   * claims land here) ∪ `teamIds`. Matched by a policy's `groups` clause.
   */
  groups?: string[];
  /** Free-form subject attribute bag (team, employment type, …) from Member.attributes. */
  attributes: Record<string, unknown>;
}

/** The target of an action, or `null` for collection/instance-scoped actions. */
export interface Resource {
  type: string; // "node" | "stack" | "service" | "org" | "setting" | ...
  id: string;
  orgId: string;
  labels: Record<string, unknown>;
  /**
   * Normalised environment (`production`, `staging`, …) derived from the
   * `swarmy.env` label (or `swarmy.app.environment`); `null` when unset.
   */
  env?: string | null;
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
