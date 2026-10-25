import {
  PG_REPLICATION_SQL,
  STACK_LABEL,
  matchStandbyTask,
  parseReplicationRows,
  type PgStandbyRow,
  type StandbyTask,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { studioViewRead } from './studio.service';

/**
 * Each standby's replay LSN and how far behind it is, in bytes and seconds
 * (board 39): `pg_stat_replication` on the primary, read through the
 * studio's bounded, audited path as the person asking (data.read). The
 * reconcile's own per-member seconds (`swarmy.db.lag.*`) stay on `db.get`;
 * this is the per-copy picture. The SQL, parser and task matcher are pure in
 * @swarmy/core (`manageddb-replication.ts`).
 */

export interface DbStandbyView extends PgStandbyRow {
  /** The member service the row's task belongs to; null when no task matched. */
  service: string | null;
  /** The server (controller node id) that task runs on. */
  nodeId: string | null;
}

export interface DbReplicationView {
  stack: string;
  cluster: string;
  measuredAt: string;
  /** The primary's current WAL position. */
  primaryLsn: string | null;
  standbys: DbStandbyView[];
}

const SERVICE_ID_LABEL = 'com.docker.swarm.service.id';

/** The cluster's running tasks, with the server each runs on. */
export function clusterTasks(ctx: OrgContext, stack: string, cluster: string): StandbyTask[] {
  const inv = ctx.hub.liveInventory(ctx.activeOrgId);
  const services = new Map(
    inv.services
      .filter((s) => (s.labels[STACK_LABEL] ?? '') === stack && s.labels['swarmy.db.cluster'] === cluster)
      .map((s) => [s.id, s.name] as const),
  );
  const mine = new Set(inv.containers.map((c) => c.id));
  const out: StandbyTask[] = [];
  for (const nodeId of ctx.hub.onlineNodeIds()) {
    for (const c of ctx.hub.latestContainers(nodeId)) {
      const service = services.get(c.serviceId ?? c.labels?.[SERVICE_ID_LABEL] ?? '');
      if (mine.has(c.id) && service && c.state === 'running') out.push({ containerId: c.id, service, nodeId });
    }
  }
  return out;
}

export async function getDbReplication(ctx: OrgContext, input: { stack: string; cluster: string }): Promise<DbReplicationView> {
  const r = await studioViewRead(ctx, { stack: input.stack, target: input.cluster, statement: PG_REPLICATION_SQL, origin: 'replication', rowCap: 64 });
  const parsed = parseReplicationRows(r);
  const tasks = clusterTasks(ctx, input.stack, input.cluster);
  return {
    stack: input.stack,
    cluster: input.cluster,
    measuredAt: new Date().toISOString(),
    primaryLsn: parsed.primaryLsn,
    standbys: parsed.standbys.map((s) => {
      const t = matchStandbyTask(s.name, tasks);
      return { ...s, service: t?.service ?? null, nodeId: t?.nodeId ?? null };
    }),
  };
}
