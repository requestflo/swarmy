import {
  CACHE_EVICTION_POLICIES,
  CACHE_PERSISTENCE_MODES,
  type CacheEvictionPolicy,
  type CachePersistence,
} from '@swarmy/core';

/**
 * A managed cache's "when full" + persistence policy — PURE (tested in
 * cache-policy.test.ts). Docker-truth on labels:
 *
 *   swarmy.cache.evictionPolicy / .persistence  DECLARED (cache.setPolicy) on every member
 *   swarmy.cache.appliedPolicy                  per data member: `<eviction>/<persistence>`
 *                                               live on its tasks AND used by its restarts
 *
 * The server reads its policy at start from `SWARMY_CACHE_POLICY`, a swarm
 * template over the member's OWN applied label, so a policy change never needs
 * a restart: cache-reconcile CONFIG SETs it live on every running task, waits
 * for the AOF rewrite / BGSAVE to land on disk, and only THEN stamps the
 * applied label (switching to AOF by restart before the rewrite would start
 * the server EMPTY). A member built before this existed hard-codes its policy
 * in its args; it gets the live CONFIG SET and then one rolling rebuild.
 */

export type { CacheEvictionPolicy, CachePersistence };

export const CACHE_EVICTION_LABEL = 'swarmy.cache.evictionPolicy';
export const CACHE_PERSISTENCE_LABEL = 'swarmy.cache.persistence';
export const CACHE_APPLIED_POLICY_LABEL = 'swarmy.cache.appliedPolicy';
export const CACHE_POLICY_ENV = 'SWARMY_CACHE_POLICY';
/** Expanded by swarm per task at creation — the member's applied label. */
export const CACHE_POLICY_ENV_TEMPLATE = `{{index .Service.Labels "${CACHE_APPLIED_POLICY_LABEL}"}}`;
/** The engines' own default RDB schedule (what every cache ran before this). */
export const RDB_SAVE_SCHEDULE = '3600 1 300 100 60 10000';
export const POLICY_APPLIED_MARKER = 'SWARMY_POLICY_OK';

export interface CachePolicy {
  eviction: CacheEvictionPolicy;
  persistence: CachePersistence;
}

const isEviction = (v: unknown): v is CacheEvictionPolicy => (CACHE_EVICTION_POLICIES as readonly unknown[]).includes(v);
const isPersistence = (v: unknown): v is CachePersistence => (CACHE_PERSISTENCE_MODES as readonly unknown[]).includes(v);

/** What every cache ran before the policy was settable: LRU (queues noeviction), AOF. */
export function defaultCachePolicy(purpose?: 'cache' | 'queue'): CachePolicy {
  return { eviction: purpose === 'queue' ? 'noeviction' : 'allkeys-lru', persistence: 'aof' };
}

export function encodeCachePolicy(p: CachePolicy): string {
  return `${p.eviction}/${p.persistence}`;
}

export function parseCachePolicy(raw: string | undefined): CachePolicy | null {
  const [eviction, persistence] = (raw ?? '').split('/');
  return isEviction(eviction) && isPersistence(persistence) ? { eviction, persistence } : null;
}

export function samePolicy(a: CachePolicy, b: CachePolicy): boolean {
  return a.eviction === b.eviction && a.persistence === b.persistence;
}

/** The declared policy off a member's labels (unset parts fall back to the purpose default). */
export function declaredCachePolicy(labels: Record<string, string> | undefined, purpose?: 'cache' | 'queue'): CachePolicy {
  const d = defaultCachePolicy(purpose);
  const e = labels?.[CACHE_EVICTION_LABEL];
  const p = labels?.[CACHE_PERSISTENCE_LABEL];
  return { eviction: isEviction(e) ? e : d.eviction, persistence: isPersistence(p) ? p : d.persistence };
}

/** What a data member runs (no stamp = built before policies: the purpose default). */
export function appliedCachePolicy(labels: Record<string, string> | undefined, purpose?: 'cache' | 'queue'): CachePolicy {
  return parseCachePolicy(labels?.[CACHE_APPLIED_POLICY_LABEL]) ?? defaultCachePolicy(purpose);
}

/** A queue store must never evict: BullMQ loses jobs under any LRU policy. */
export function queuePolicyRefusal(purpose: 'cache' | 'queue' | undefined, eviction: CacheEvictionPolicy): string | null {
  return purpose === 'queue' && eviction !== 'noeviction'
    ? 'a queue store must keep noeviction: under an LRU policy a full store drops queued jobs'
    : null;
}

const flags = (p: CachePersistence): { aof: 'yes' | 'no'; save: string } =>
  p === 'off' ? { aof: 'no', save: '' } : { aof: p === 'aof' ? 'yes' : 'no', save: RDB_SAVE_SCHEDULE };

/**
 * The server start prelude: `$E` (eviction), `$A` (appendonly) and `$S` (save)
 * from `SWARMY_CACHE_POLICY`, each falling back to `fallback` when the value
 * is missing or not a known policy — so a bad label can never stop a start.
 */
export function policyStartPrelude(fallback: CachePolicy): string {
  const f = flags(fallback.persistence);
  const set = (p: CachePersistence) => `A=${flags(p).aof}; S="${flags(p).save}"`;
  return [
    `P="\${${CACHE_POLICY_ENV}:-}"; E="\${P%%/*}"; M="\${P#*/}"`,
    `case "$E" in ${CACHE_EVICTION_POLICIES.join('|')}) ;; *) E=${fallback.eviction};; esac`,
    `case "$M" in off) ${set('off')};; rdb) ${set('rdb')};; aof) ${set('aof')};; *) A=${f.aof}; S="${f.save}";; esac`,
  ].join('\n');
}

/** The policy flags the server command passes (reads the prelude's variables). */
export const POLICY_SERVER_ARGS = '--maxmemory-policy "$E" --appendonly "$A" --save "$S"';

/**
 * Exec'd inside one running member: CONFIG SET the policy, snapshot when
 * leaving AOF (so a restart right after keeps the data), wait (bounded) until
 * nothing is still being persisted, and print {@link POLICY_APPLIED_MARKER}
 * only when it landed — the caller stamps the applied label on that alone.
 */
export function policyApplyScript(engine: 'valkey' | 'redis', target: CachePolicy): string {
  const f = flags(target.persistence);
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  return [
    'set -u',
    'PW="$(cat /run/secrets/cache-password)"',
    `c() { ${cli} --no-auth-warning -a "$PW" "$@"; }`,
    `OUT="$(c CONFIG SET maxmemory-policy ${target.eviction} appendonly ${f.aof} save "${f.save}" 2>&1)"`,
    'case "$OUT" in *OK*) ;; *) echo "CONFIG SET failed: $OUT"; exit 1;; esac',
    ...(target.persistence === 'aof' ? [] : ['c BGSAVE >/dev/null 2>&1 || true']),
    'i=0; I=""',
    'while [ "$i" -lt 60 ]; do',
    '  I="$(c INFO persistence 2>/dev/null | tr -d \'\\r\')"',
    '  case "$I" in *aof_rewrite_in_progress:1*|*aof_rewrite_scheduled:1*|*rdb_bgsave_in_progress:1*) i=$((i+1)); sleep 1;; *) break;; esac',
    'done',
    'if [ "$i" -ge 60 ]; then echo "still writing to disk"; exit 1; fi',
    ...(target.persistence === 'aof'
      ? ['case "$I" in *aof_last_bgrewrite_status:ok*) ;; *) echo "AOF rewrite failed"; exit 1;; esac']
      : []),
    `echo ${POLICY_APPLIED_MARKER}`,
  ].join('\n');
}
