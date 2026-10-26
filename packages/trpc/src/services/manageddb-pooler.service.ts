import {
  DB_POOLER_LABEL,
  STACK_LABEL,
  POOLER_DEFAULT,
  POOLER_POOL_MAX,
  POOLER_POOL_MIN,
  encodePoolerConfig,
  isPoolSize,
  parsePoolerConfig,
  poolerServiceName,
  samePoolerConfig,
  type PoolerConfig,
  type PoolerMode,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, commandRejected, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { appsThroughPooler } from './manageddb-connect.service';
import { liveCluster } from './manageddb-extensions.service';

/**
 * A managed Postgres cluster's PgBouncer (board 39). The mutation only
 * rewrites the primary's `swarmy.db.pooler` label; the manageddb reconcile
 * creates, updates or removes the `<stack>_<cluster>-pooler` service to match
 * (manageddb-pooler.ts in the api workers). Docker is the truth; no DB rows.
 */

export interface SetDbPoolerInput {
  stack: string;
  cluster: string;
  enabled: boolean;
  /** Omitted: the current mode, else transaction. */
  mode?: PoolerMode;
  /** Omitted: the current pool size, else 20. */
  poolSize?: number;
}

export interface SetDbPoolerResult {
  stack: string;
  cluster: string;
  /** The declaration now; null = off. */
  pooler: PoolerConfig | null;
  changed: boolean;
  /** The service the reconcile converges (`<stack>_<cluster>-pooler`). */
  service: string;
}

export async function setDbPooler(ctx: OrgContext, input: SetDbPoolerInput): Promise<SetDbPoolerResult> {
  const { primary } = liveCluster(ctx, input.stack, input.cluster);
  const current = parsePoolerConfig(primary.labels[DB_POOLER_LABEL]);
  let next: PoolerConfig | null = null;
  if (input.enabled) {
    next = {
      mode: input.mode ?? current?.mode ?? POOLER_DEFAULT.mode,
      poolSize: input.poolSize ?? current?.poolSize ?? POOLER_DEFAULT.poolSize,
    };
    if (!isPoolSize(next.poolSize)) {
      throw badRequest(`the pool size must be a whole number between ${POOLER_POOL_MIN} and ${POOLER_POOL_MAX}`);
    }
  }
  const result = { stack: input.stack, cluster: input.cluster, pooler: next, service: poolerServiceName(input.stack, input.cluster) };
  if (samePoolerConfig(current, next)) return { ...result, changed: false };
  if (!next) {
    // Never leave an app with a DATABASE_URL naming a pooler that is gone.
    const mine = ctx.hub.liveInventory(ctx.activeOrgId).services.filter((s) => (s.labels[STACK_LABEL] ?? '') === input.stack);
    const through = appsThroughPooler(mine, input.cluster);
    if (through.length > 0) {
      throw commandRejected(`${through.join(', ')} ${through.length === 1 ? 'connects' : 'connect'} through the pooler: connect ${through.length === 1 ? 'it' : 'them'} directly first`);
    }
  }

  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: next ? { [DB_POOLER_LABEL]: encodePoolerConfig(next) } : {},
      removeKeys: next ? [] : [DB_POOLER_LABEL],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'db.pooler.set',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { primary: primary.name, from: current, to: next },
  });
  return { ...result, changed: true };
}
