/**
 * What a managed Postgres password rotation (`db.rotatePassword`) touches,
 * now that a cluster may run a pooler. PURE.
 *
 *   members    the Postgres members move onto the new
 *              password secret: never the pooler, never the WAL shipper (both
 *              carry the cluster label, neither runs Postgres; patching them
 *              with the Postgres boot layer would break them).
 *   untouched  the pooler keeps running as it is: it logs in as its own
 *              `swarmy_pooler` role (its own secret, not rotated) and looks
 *              each app's verifier up live (`auth_query`), so the new
 *              password works through it on the next login.
 *   apps       every wired app is re-minted onto the new version, each on
 *              its own path: a direct `…-pg-url`, or a `…-pg-pool-url`.
 *   retire     the URL kinds whose older versions go once nothing mounts them.
 */
import type { DbSecretKind } from './manageddb-pg';
import { DB_INJECT_VIA_LABEL, type DbConnectVia } from './manageddb-pooler';

interface ServiceLike {
  name: string;
  labels: Record<string, string>;
}

export interface PoolerRotationPlan {
  members: string[];
  untouched: string[];
  apps: Array<{ service: string; envVar: string; via: DbConnectVia }>;
  retire: DbSecretKind[];
}

/** How an app wired to a cluster reaches it (its `swarmy.db.inject.via`). */
export function connectViaOf(labels: Record<string, string>): DbConnectVia {
  return labels[DB_INJECT_VIA_LABEL] === 'pooler' ? 'pooler' : 'direct';
}

/** A cluster-labelled service that runs Postgres (not the pooler, not the WAL shipper). */
export function isPgMemberService(labels: Record<string, string>): boolean {
  return labels['swarmy.db.role'] !== 'pooler' && labels['swarmy.db.walShipper'] !== 'true';
}

/** `services`: the stack's live services. */
export function planPoolerRotation(cluster: string, services: readonly ServiceLike[]): PoolerRotationPlan {
  const own = services.filter((s) => s.labels['swarmy.db.cluster'] === cluster);
  return {
    members: own.filter((s) => isPgMemberService(s.labels)).map((s) => s.name),
    untouched: own.filter((s) => !isPgMemberService(s.labels)).map((s) => s.name),
    apps: services
      .filter((s) => s.labels['swarmy.db.inject'] === cluster && s.labels['swarmy.db.cluster'] !== cluster)
      .map((s) => ({ service: s.name, envVar: s.labels['swarmy.db.inject.var'] || 'DATABASE_URL', via: connectViaOf(s.labels) })),
    retire: ['password', 'url', 'ro-url', 'pool-url'],
  };
}
