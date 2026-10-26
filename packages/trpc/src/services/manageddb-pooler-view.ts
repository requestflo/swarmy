import {
  DB_POOLER_LABEL,
  DB_POOLER_TARGET_LABEL,
  POOLER_ROLE,
  buildInventory,
  parsePoolerConfig,
  parseShowPools,
  planPooler,
  planPoolerRotation,
  poolerAddress,
  poolerPoolsScript,
  poolerServiceName,
  type DbPoolerView,
  type InvService,
  type PoolerTraffic,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { resolveExecTarget } from './live-resolve';

/**
 * `db.pooler`: a cluster's PgBouncer as the Postgres page shows it — the
 * declaration, the service and the writer it points at (Docker truth), the
 * apps going through it, and its live client / server counts, read from its
 * admin console inside the pooler container (the auth secret never leaves it).
 */

const READ_TIMEOUT_MS = 10_000;

async function readTraffic(ctx: OrgContext, pooler: InvService): Promise<PoolerTraffic | null> {
  if (pooler.replicas.running < 1) return null;
  const target = resolveExecTarget(ctx, pooler.id, { newest: true });
  if (!target) return null;
  const res = await ctx.hub
    .dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      { target: { containerId: target.containerId }, cmd: ['sh', '-c', poolerPoolsScript()], tty: false, stream: false },
      { timeoutMs: READ_TIMEOUT_MS },
    )
    .catch(() => null);
  return res && res.exitCode === 0 ? parseShowPools(res.output ?? '') : null;
}

export async function getDbPooler(ctx: OrgContext, input: { stack: string; cluster: string }): Promise<DbPoolerView> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const mine = buildInventory(services, containers).services.filter((s) => s.stack === input.stack);
  const own = mine.filter((s) => s.labels['swarmy.db.cluster'] === input.cluster);
  const primary = own.find((s) => s.labels['swarmy.db.engine'] && s.labels['swarmy.db.role'] === 'primary' && !s.labels['swarmy.db.member']);
  if (!primary) throw notFound('db cluster primary', `${input.stack}/${input.cluster}`);
  const pooler = own.find((s) => s.labels['swarmy.db.role'] === POOLER_ROLE);
  const declared = parsePoolerConfig(primary.labels[DB_POOLER_LABEL]);
  const plan = planPooler({
    stack: input.stack,
    cluster: input.cluster,
    declared,
    writer: { name: primary.name, running: primary.replicas.running },
    ...(pooler ? { pooler } : {}),
  });
  return {
    stack: input.stack,
    cluster: input.cluster,
    declared,
    service: pooler?.name ?? poolerServiceName(input.stack, input.cluster),
    address: poolerAddress(input.stack, input.cluster),
    status: pooler?.status ?? 'absent',
    running: pooler?.replicas.running ?? 0,
    desired: pooler?.replicas.desired ?? 0,
    target: pooler?.labels[DB_POOLER_TARGET_LABEL] ?? null,
    writer: primary.name,
    converging: plan.kind === 'deploy' || plan.kind === 'remove',
    traffic: pooler ? await readTraffic(ctx, pooler) : null,
    // The same reading of the inject labels a rotation uses.
    apps: planPoolerRotation(input.cluster, mine).apps,
  };
}
