import {
  DB_AVOID_NODE_LABEL,
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  DB_PIN_NODE_LABEL,
  DB_SWITCHOVER_LABEL,
  PG_ENV,
  applyPgMember,
  dbFloatingPlacement,
  dbRolePlacementLabels,
  pgReplicaEnv,
  type DbPlacementNode,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';

// Mirrors manageddb-reconcile.ts (a worker cannot subpath-import trpc internals).
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_LEADER_LABEL = 'swarmy.db.leader';
const DB_REGION_LABEL = 'swarmy.db.region';
const DB_PITR_APPLIED_LABEL = 'swarmy.db.pitr.applied';
const REGION_NODE_LABEL = 'swarmy.region';
const PG_PORT = 5432;
const REPLICATION_USER = 'repl';

function envRecord(env: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/**
 * Spec repointing a replica-role service at the promoted writer. `epoch` is
 * the promotion's rejoin token: a standby just re-points; a member holding
 * WRITER data (the demoted ex-primary) moves it aside and re-clones — see
 * @swarmy/core manageddb-pg. `region` places a member whose labels name no
 * region (a geo cluster's demoted writer stays in the region of its data).
 */
export function repointSpec(
  s: SwarmServiceInfo,
  promoted: string,
  net: string,
  epoch: string,
  nodes?: readonly DbPlacementNode[],
  region: string | undefined = s.labels[DB_REGION_LABEL],
): ServiceSpec {
  const env = envRecord(s.env ?? []);
  const networks = (s.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  // A free-floating member keeps preferring database-role servers; a pinned
  // one (the demoted ex-primary) stays where its data is.
  const floating = nodes && !s.labels[DB_PIN_NODE_LABEL];
  const avoidNode = s.labels[DB_AVOID_NODE_LABEL];
  const placed = floating
    ? dbFloatingPlacement({ nodes, replicas: s.desiredReplicas ?? 1, ...(region ? { region } : {}), ...(avoidNode ? { avoidNode } : {}) })
    : { constraints: region ? [`node.labels.${REGION_NODE_LABEL}==${region}`] : [], onRole: false };
  const base: Record<string, string> = {
    ...s.labels,
    [DB_ROLE_LABEL]: 'replica',
    [DB_LEADER_LABEL]: promoted,
  };
  const labels = floating ? dbRolePlacementLabels(base, placed) : base;
  // The failover wait/confirm handshake is over once a writer is promoted.
  delete labels[DB_FAILOVER_PENDING_LABEL];
  delete labels[DB_FAILOVER_CONFIRM_LABEL];
  // A planned switchover (volume mobility) is over once a writer is promoted.
  delete labels[DB_SWITCHOVER_LABEL];
  // A demoted ex-primary loses its PITR marker — its archive bits drop with the
  // redeploy (live truth carries no mounts/configs) and the new writer re-earns
  // them from the PITR convergence.
  delete labels[DB_PITR_APPLIED_LABEL];
  // Storage is carried forward from the member's own labels: the demoted
  // ex-primary keeps its pinned data volume, replicas keep their per-node one.
  const replEnv = pgReplicaEnv({
    password: env[PG_ENV.password] ?? '',
    replicationUser: env[PG_ENV.replicationUser] ?? REPLICATION_USER,
    replicationPassword: env[PG_ENV.replicationPassword] ?? env[PG_ENV.password] ?? '',
    primaryHost: promoted,
    primaryPort: PG_PORT,
    rejoin: epoch,
  });
  return applyPgMember<ServiceSpec>({
    name: s.name,
    image: s.image,
    mode: { replicated: { replicas: s.desiredReplicas ?? 1 } },
    env: { ...env, ...replEnv },
    labels,
    networks: networks.length > 0 ? networks : [net],
    ...((s.secrets ?? []).length > 0 ? { secrets: (s.secrets ?? []).map((n) => ({ source: n })) } : {}),
    ...((s.configs ?? []).length > 0 ? { configs: (s.configs ?? []).map((n) => ({ source: n })) } : {}),
    ...(placed.constraints.length > 0 ? { placement: { constraints: placed.constraints } } : {}),
  }, labels);
}
