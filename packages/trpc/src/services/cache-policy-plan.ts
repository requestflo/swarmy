import {
  CACHE_POLICY_ENV,
  appliedCachePolicy,
  declaredCachePolicy,
  defaultCachePolicy,
  samePolicy,
  type CachePolicy,
} from './cache-policy';

/**
 * The cache-reconcile policy step for ONE data member — PURE. Signature-gated
 * on the member's `swarmy.cache.appliedPolicy` stamp (and, for the primary,
 * the live INFO sample): a member already running the declared policy needs
 * no command at all.
 *
 *   none   — applied (and live, when sampled) == declared
 *   apply  — CONFIG SET the declared policy live on every running task, then
 *            stamp the applied label (`rebuild: false`), or — a member built
 *            before policies were settable, whose args hard-code the old
 *            policy — rebuild it once with the template env (`rebuild: true`,
 *            a rolling restart), because a plain restart would revert it.
 */

export type CachePolicyStep = { kind: 'none' } | { kind: 'apply'; target: CachePolicy; rebuild: boolean };

/** What the primary actually runs, read off `INFO` (memory + persistence sections). */
export interface LivePolicySample {
  eviction: string;
  aof: boolean;
}

/** Does this member start from `SWARMY_CACHE_POLICY` (built with the template env)? */
export function usesPolicyEnv(env: readonly string[] | undefined): boolean {
  return (env ?? []).some((kv) => kv.startsWith(`${CACHE_POLICY_ENV}=`));
}

/** `maxmemory_policy` + `aof_enabled` off an INFO dump, or null when absent. */
export function parseLivePolicy(info: string): LivePolicySample | null {
  const field = (k: string) => new RegExp(`^${k}:(.*)$`, 'm').exec(info.replace(/\r/g, ''))?.[1]?.trim();
  const eviction = field('maxmemory_policy');
  const aof = field('aof_enabled');
  if (!eviction || (aof !== '0' && aof !== '1')) return null;
  return { eviction, aof: aof === '1' };
}

export function planCachePolicy(input: {
  /** The member's own labels (its applied stamp). */
  labels: Record<string, string>;
  env: readonly string[] | undefined;
  /** The cluster anchor's labels (the declared policy). */
  anchorLabels: Record<string, string>;
  purpose?: 'cache' | 'queue';
  live?: LivePolicySample | null;
}): CachePolicyStep {
  const declared = declaredCachePolicy(input.anchorLabels, input.purpose);
  const applied = appliedCachePolicy(input.labels, input.purpose);
  const live = input.live;
  const drift = Boolean(live) && (live!.eviction !== applied.eviction || live!.aof !== (applied.persistence === 'aof'));
  if (samePolicy(applied, declared) && !drift) return { kind: 'none' };
  const legacy = !usesPolicyEnv(input.env);
  return {
    kind: 'apply',
    target: declared,
    rebuild: legacy && !samePolicy(declared, defaultCachePolicy(input.purpose)),
  };
}
