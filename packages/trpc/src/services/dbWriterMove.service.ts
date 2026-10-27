import { DB_AVOID_NODE_LABEL, DB_PIN_NODE_LABEL, DB_SWITCHOVER_LABEL } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { rebuildDbMemberSpec } from './manageddb.service';
import { runDbSwitchover, type SwitchoverIo } from './manageddb-switchover.run';
import { planDbSwitchover, switchoverMembers, switchoverWriter } from './manageddb-switchover.service';
import { nodesRunning, waitFor, type MoverDeps } from './volumeMove.service';

/**
 * Move a managed Postgres cluster's WRITER off a server (the server-retire
 * flow, decommission.service `db-switchover` / `db-standby-switchover`).
 * The switch itself is the ONE planned switchover (`runDbSwitchover`: the
 * same plan, refusals, pause, catch-up, the reconcile's promotion pass and
 * its repoint). What is retire-specific stays here:
 *
 *   - a standby on another server first (added when there is none, the
 *     topology lifted from `single` for it), and time for it to catch up
 *     while writes continue (the plan's `behind` / `not-streaming` wait);
 *   - the rejoin: the old writer is rebuilt un-pinned and kept off the
 *     server, so it re-clones elsewhere instead of on the server leaving;
 *   - the declared copies and topology put back afterwards.
 *
 * A copy that shares its service with other copies is fine: the plan never
 * picks one on the server leaving, and the promotion pass promotes that copy
 * alone. A refusal the operator must settle (a held
 * failover) comes back as `refused` so the retire run waits for them instead
 * of failing. An app wired straight to the writer is none: it restarts onto
 * the new writer with the promotion pass.
 */

export interface DbWriterMoveDeps extends MoverDeps {
  io: SwitchoverIo;
  /** manageddb.setReplicas / setTopology (labels + scale). */
  setReplicas(stack: string, cluster: string, replicas: number): Promise<void>;
  setTopology(stack: string, cluster: string, topology: string): Promise<void>;
}

export type DbWriterMove =
  | { kind: 'moved'; promoted: string; demoted: string; addedReplica: boolean }
  | { kind: 'refused'; reason: string };

const REPLICA_TIMEOUT_MS = 15 * 60_000;
/** Each plan reads pg_stat_replication through the audited studio path: poll gently. */
const PLAN_POLL_MS = 10_000;
const WAITABLE = new Set(['behind', 'not-streaming']);

export async function moveDbWriterOff(
  ctx: OrgContext,
  input: { stack: string; cluster: string; avoidNodeId: string },
  deps: DbWriterMoveDeps,
  say: (message: string) => void = () => {},
): Promise<DbWriterMove> {
  const { stack, cluster, avoidNodeId } = input;
  const primary = switchoverWriter(switchoverMembers(ctx, stack, cluster));
  if (!primary) throw notFound('db cluster', cluster);
  const topology = primary.labels['swarmy.db.topology'] ?? 'primary-replica';
  if (topology === 'active-active') throw commandRejected('active-active writers are not moved automatically.');
  const declared = Number(primary.labels['swarmy.db.replicas'] ?? '0') || 0;
  const replicaElsewhere = () =>
    switchoverMembers(ctx, stack, cluster).find(
      (s) => s.labels['swarmy.db.role'] === 'replica' && (s.runningReplicas ?? 0) > 0 && nodesRunning(ctx, s.name).some((n) => n !== avoidNodeId),
    );

  let addedReplica = false;
  if (!replicaElsewhere()) {
    say(`Adding a copy of ${cluster} on another server first.`);
    if (topology === 'single') await deps.setTopology(stack, cluster, 'primary-replica');
    await deps.setReplicas(stack, cluster, Math.max(1, declared));
    addedReplica = true;
    await waitFor(deps, REPLICA_TIMEOUT_MS, () => Boolean(replicaElsewhere()), 'the new copy to start');
  }
  const target = replicaElsewhere()!.name;

  say(`Waiting for ${target} to catch up.`);
  const deadline = deps.now() + REPLICA_TIMEOUT_MS;
  // Never a copy on the server leaving, even one sharing its service with a copy elsewhere.
  let { plan } = await planDbSwitchover(ctx, { stack, cluster, target, avoidNodeId });
  while (!plan.ok && WAITABLE.has(plan.code) && deps.now() <= deadline) {
    await deps.sleep(PLAN_POLL_MS);
    ({ plan } = await planDbSwitchover(ctx, { stack, cluster, target, avoidNodeId }));
  }
  if (!plan.ok) {
    if (WAITABLE.has(plan.code)) throw commandRejected(`${plan.reason} (gave up after 15 minutes)`);
    return { kind: 'refused', reason: plan.reason };
  }

  const keep = addedReplica ? declared : Math.max(1, declared);
  const writerNode = plan.nodeId ?? nodesRunning(ctx, target)[0] ?? '';
  const res = await runDbSwitchover(ctx, { stack, cluster, target }, deps.io, {
    plan,
    say,
    rejoin: (demoted) => rejoinElsewhere(ctx, demoted, avoidNodeId, writerNode, keep),
  });
  if (addedReplica) {
    // Restore what was declared: setReplicas scales the (now) replica — the ex-primary.
    await deps.setReplicas(stack, cluster, declared);
    if (topology === 'single') await deps.setTopology(stack, cluster, 'single');
  }
  return { kind: 'moved', promoted: res.to, demoted: res.from, addedReplica };
}

/** The old writer, un-pinned and kept off `avoidNodeId`: it re-clones on another server. */
async function rejoinElsewhere(ctx: OrgContext, demoted: SwarmServiceInfo, avoidNodeId: string, writerNode: string, replicas: number): Promise<void> {
  const labels = { ...demoted.labels };
  delete labels[DB_PIN_NODE_LABEL];
  delete labels[DB_SWITCHOVER_LABEL];
  // The promoted copy's server (a reshaped writer may not be running yet).
  const writerSwarm = ctx.hub.swarmNodeIdFor(writerNode);
  if (writerSwarm) labels[DB_AVOID_NODE_LABEL] = writerSwarm;
  const spec = rebuildDbMemberSpec(demoted, labels, replicas);
  const avoid = ctx.hub.swarmNodeIdFor(avoidNodeId);
  if (avoid) {
    const constraints = (spec.placement?.constraints ?? []).filter((c) => c !== `node.id!=${avoid}`);
    spec.placement = { ...(spec.placement ?? {}), constraints: [...constraints, `node.id!=${avoid}`] };
  }
  const manager = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(manager.id, 'service.deploy', { spec, pullPolicy: 'missing' });
}
