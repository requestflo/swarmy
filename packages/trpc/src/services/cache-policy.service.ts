import type { CacheEvictionPolicy, CachePersistence } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { cacheBaseName, getCacheCluster } from './cache.service';
import { CACHE_EVICTION_LABEL, CACHE_PERSISTENCE_LABEL, queuePolicyRefusal } from './cache-policy';

/**
 * `cache.setPolicy` — change what a managed cache does when it is full and how
 * it keeps its data across restarts. Docker-truth: it only stamps the DECLARED
 * `swarmy.cache.evictionPolicy` / `.persistence` labels on every member (a
 * label update restarts nothing). cache-reconcile then applies it to the
 * running members (CONFIG SET live, a rolling rebuild only for members built
 * before policies were settable) and stamps `swarmy.cache.appliedPolicy`; the
 * view's `policyApplied` reads false until it has.
 */

export interface SetCachePolicyInput {
  stack: string;
  cluster: string;
  evictionPolicy?: CacheEvictionPolicy;
  persistence?: CachePersistence;
}

export interface SetCachePolicyResult {
  cluster: string;
  evictionPolicy: CacheEvictionPolicy;
  persistence: CachePersistence;
  /** True when nothing changed (already declared); false = cache-reconcile applies it next. */
  unchanged: boolean;
}

export async function setCachePolicy(ctx: OrgContext, input: SetCachePolicyInput): Promise<SetCachePolicyResult> {
  const view = getCacheCluster(ctx, { stack: input.stack, cluster: input.cluster });
  const from = { evictionPolicy: view.evictionPolicy, persistence: view.persistence };
  const to = {
    evictionPolicy: input.evictionPolicy ?? view.evictionPolicy,
    persistence: input.persistence ?? view.persistence,
  };
  const refusal = queuePolicyRefusal(view.purpose, to.evictionPolicy);
  if (refusal) throw commandRejected(refusal);
  const unchanged = from.evictionPolicy === to.evictionPolicy && from.persistence === to.persistence;
  if (!unchanged) {
    const node = await resolveManagerNode(ctx);
    try {
      for (const m of view.members) {
        await ctx.hub.dispatch(node.id, 'service.updateLabels', {
          service: m.service,
          add: { [CACHE_EVICTION_LABEL]: to.evictionPolicy, [CACHE_PERSISTENCE_LABEL]: to.persistence },
          removeKeys: [],
        });
      }
    } catch (e) {
      throw mapDispatchError(e);
    }
    await writeAudit(ctx, {
      action: 'cache.setPolicy',
      targetType: 'cacheCluster',
      targetId: cacheBaseName(input.stack, input.cluster),
      metadata: { from, to },
    });
  }
  return { cluster: input.cluster, ...to, unchanged };
}
