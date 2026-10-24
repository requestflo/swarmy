import { NODE_DATABASE_LABEL } from './types';

/**
 * Managed-Postgres placement and the database role (`swarmy.node.database`).
 *
 * An operator marks servers that should hold databases with the database
 * role. Placement PREFERS those servers and falls back to today's placement
 * when they can't take the member:
 *
 *  - a PINNED member (primary, active-active extra primary) is pinned to a
 *    database-role server first — see `explainPinNode`'s `preferLabel`;
 *  - a FREE-FLOATING member (a read replica, one task per server) is
 *    constrained to database-role servers in its region only when there are
 *    enough of them for every task. Otherwise it keeps the region-only
 *    placement (the whole swarm when unregioned).
 *
 * A member placed on the role carries {@link DB_ROLE_PLACED_LABEL}, so a later
 * scale-up past the role servers (or one of them leaving) can be noticed and
 * rebuilt with the fallback placement instead of leaving tasks pending.
 * Members are never moved ONTO role servers after the fact: a replica move is
 * a re-clone, and "prefer" must not churn a healthy cluster.
 *
 * Pure: no IO. The provision path (@swarmy/trpc manageddb.service) and the
 * manageddb-reconcile worker both import it, so they can't disagree.
 */

/** Placement constraint keeping a member on servers carrying the database role. */
export const DB_ROLE_CONSTRAINT = `node.labels.${NODE_DATABASE_LABEL}==true`;
/** Stamped on a free-floating member that was placed with {@link DB_ROLE_CONSTRAINT}. */
export const DB_ROLE_PLACED_LABEL = 'swarmy.db.rolePlaced';
/** Node label naming a server's region (mirrors region/geodns placement). */
const REGION_NODE_LABEL = 'swarmy.region';

/** A swarm node as far as database placement cares. */
export interface DbPlacementNode {
  swarmNodeId: string;
  status: string;
  availability: string;
  labels?: Record<string, string>;
}

export interface DbFloatingPlacementInput {
  nodes: readonly DbPlacementNode[];
  /** Region the member is pinned to (geo siblings); undefined = the whole swarm. */
  region?: string;
  /** Tasks that need a server each (replica members run one task per server). */
  replicas: number;
  /** Server the member must stay off (the primary's pin on a multi-node swarm). */
  avoidNode?: string;
}

export interface DbFloatingPlacement {
  constraints: string[];
  /** True when {@link DB_ROLE_CONSTRAINT} is among the constraints. */
  onRole: boolean;
}

/** Does this server carry the database role? */
export function hasDatabaseRole(n: { labels?: Record<string, string> }): boolean {
  return n.labels?.[NODE_DATABASE_LABEL] === 'true';
}

/** Ready + active database-role servers that can take one task of the member. */
export function databaseRoleServers(input: DbFloatingPlacementInput): string[] {
  return input.nodes
    .filter(
      (n) =>
        n.status === 'ready' &&
        n.availability === 'active' &&
        hasDatabaseRole(n) &&
        n.swarmNodeId !== input.avoidNode &&
        (!input.region || n.labels?.[REGION_NODE_LABEL] === input.region),
    )
    .map((n) => n.swarmNodeId)
    .sort();
}

/**
 * Constraints for a free-floating member: its region (if any), plus the
 * database role when enough role servers in that region can take every task.
 */
export function dbFloatingPlacement(input: DbFloatingPlacementInput): DbFloatingPlacement {
  const region = input.region ? [`node.labels.${REGION_NODE_LABEL}==${input.region}`] : [];
  const onRole = databaseRoleServers(input).length >= Math.max(1, input.replicas);
  return { constraints: onRole ? [...region, DB_ROLE_CONSTRAINT] : region, onRole };
}

/** The role-placement marker labels to stamp for a placement (add/remove form). */
export function dbRolePlacementLabels(
  labels: Record<string, string>,
  placement: DbFloatingPlacement,
): Record<string, string> {
  const out = { ...labels };
  if (placement.onRole) out[DB_ROLE_PLACED_LABEL] = 'true';
  else delete out[DB_ROLE_PLACED_LABEL];
  return out;
}

/**
 * A member placed on the role that the role servers can no longer hold (scaled
 * up past them, or one left): rebuild it with the fallback placement, or its
 * extra tasks stay pending. Never true for a member placed without the role.
 */
export function rolePlacementOutgrown(
  labels: Record<string, string>,
  input: DbFloatingPlacementInput,
): boolean {
  if (labels[DB_ROLE_PLACED_LABEL] !== 'true' || input.replicas <= 0) return false;
  return !dbFloatingPlacement(input).onRole;
}
