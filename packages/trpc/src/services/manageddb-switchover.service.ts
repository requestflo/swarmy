import {
  DB_FAILOVER_PENDING_LABEL,
  STACK_LABEL,
  SWITCHOVER_BUSY,
  connectViaOf,
  planSwitchover,
  plannedRestartActive,
  switchoverRequested,
  type SwitchoverMember,
  type SwitchoverPlan,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { DB_INJECT_LABEL } from './manageddb.service';
import { clusterTasks, getDbReplication } from './manageddb-replication.service';
import { switchoverInFlight } from './manageddb-switchover.runs';

/**
 * `db.switchover`'s live facts → the pure plan (@swarmy/core
 * `planSwitchover`). Gathers the cluster's members off the live inventory,
 * each standby's position (`db.replication`: pg_stat_replication on the
 * writer, through the studio's audited read as the caller), the apps wired
 * straight to the writer (no refusal: they restart onto the new writer, and
 * the plan names them), and anything else mid-flight on it. The dashboard
 * runs the SAME plan on the same three reads, so a refusal it shows is the
 * one this returns.
 */

/** The cluster's Postgres member services (not its pooler or WAL shipper). */
export function switchoverMembers(ctx: OrgContext, stack: string, cluster: string): SwarmServiceInfo[] {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === stack && s.labels['swarmy.db.cluster'] === cluster && s.labels['swarmy.db.engine']);
}

/** The base writer: role primary, not an active-active extra. */
export function switchoverWriter(members: readonly SwarmServiceInfo[]): SwarmServiceInfo | undefined {
  return members.find((s) => s.labels['swarmy.db.role'] === 'primary' && !s.labels['swarmy.db.member']);
}

/** Why the writer can't be switched right now (something else is in flight), or null. */
export function switchoverBusy(ctx: OrgContext, stack: string, cluster: string, now = Date.now()): string | null {
  const members = switchoverMembers(ctx, stack, cluster);
  const writer = switchoverWriter(members);
  if (members.some((s) => s.labels[DB_FAILOVER_PENDING_LABEL])) return SWITCHOVER_BUSY.held;
  if (switchoverInFlight(ctx.activeOrgId, stack, cluster) || switchoverRequested(writer?.labels, now)) return SWITCHOVER_BUSY.running;
  if (plannedRestartActive(writer?.labels, now)) return SWITCHOVER_BUSY.restarting;
  return null;
}

/** Apps whose DATABASE_URL names the writer itself, not the pooler: the promotion pass rolls them onto the new writer. */
export function directApps(ctx: OrgContext, stack: string, cluster: string): string[] {
  return ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.filter((s) => s.labels[STACK_LABEL] === stack && s.labels[DB_INJECT_LABEL] === cluster && connectViaOf(s.labels) !== 'pooler')
    .map((s) => s.name)
    .sort();
}

/** "wkr-2's copy": a member's copy by the server its running task is on (else the service). */
export function copyNamer(ctx: OrgContext, stack: string, cluster: string): (service: string) => string {
  const tasks = clusterTasks(ctx, stack, cluster);
  return (service) => {
    const node = tasks.find((t) => t.service === service)?.nodeId;
    const host = node ? ctx.hub.nodeInfoFor(node)?.hostname : undefined;
    return host ? `${host}'s copy` : service;
  };
}

export interface SwitchoverFacts {
  plan: SwitchoverPlan;
  writer: SwarmServiceInfo | undefined;
}

/** Plan a switchover of `<stack>/<cluster>` to `target` (or the most caught-up copy). Never throws a refusal. */
export async function planDbSwitchover(ctx: OrgContext, input: { stack: string; cluster: string; target?: string }): Promise<SwitchoverFacts> {
  const members = switchoverMembers(ctx, input.stack, input.cluster);
  const writer = switchoverWriter(members);
  if (members.length === 0) throw notFound('db cluster', `${input.stack}/${input.cluster}`);
  const rows = writer && (writer.runningReplicas ?? 0) > 0
    ? await getDbReplication(ctx, input).then((r) => r.standbys).catch((e: unknown) => {
        throw commandRejected(`couldn't read how far behind each copy is: ${e instanceof Error ? e.message : String(e)}`);
      })
    : [];
  const where = copyNamer(ctx, input.stack, input.cluster);
  const view = (s: SwarmServiceInfo): SwitchoverMember => ({
    service: s.name,
    role: s === writer ? 'primary' : (s.labels['swarmy.db.role'] ?? ''),
    desired: s.desiredReplicas ?? 0,
    running: s.runningReplicas ?? 0,
  });
  const plan = planSwitchover({
    cluster: input.cluster,
    topology: writer?.labels['swarmy.db.topology'] ?? 'primary-replica',
    members: members.map((s) => (s !== writer && s.labels['swarmy.db.role'] === 'primary' ? { ...view(s), role: 'writer' } : view(s))),
    standbys: rows.map((r) => ({ service: r.service, nodeId: r.nodeId, state: r.state, lagBytes: r.lagBytes })),
    busy: switchoverBusy(ctx, input.stack, input.cluster),
    directApps: directApps(ctx, input.stack, input.cluster),
    ...(input.target ? { target: input.target } : {}),
    copyName: where,
  });
  return { plan, writer };
}
