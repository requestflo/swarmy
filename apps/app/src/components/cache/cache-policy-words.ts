import { CACHE_EVICTION_POLICIES, CACHE_PERSISTENCE_MODES, type CacheEvictionPolicy, type CachePersistence } from '@swarmy/core';
import type { CacheView } from './cache-words';

/**
 * A cache's "when full" and persistence settings in plain words (board 41,
 * DataStores). Both are settable (`cache.setPolicy`, `swarmy.cache.*`
 * labels); cache-reconcile applies a change to the running copies without a
 * restart. PURE — tested in cache-policy-words.test.ts.
 */

export interface PolicyChoice<T extends string> {
  value: T;
  /** Button text at Controls. */
  label: string;
  /** "It …" sentence. */
  say: string;
  tech: string;
}

const RDB = 'save 3600 1 300 100 60 10000';

export const EVICTION_CHOICES: PolicyChoice<CacheEvictionPolicy>[] = [
  { value: 'allkeys-lru', label: 'Drop the oldest', say: 'drops the least recently used keys first', tech: 'maxmemory-policy allkeys-lru' },
  {
    value: 'volatile-lru',
    label: 'Drop expiring keys',
    say: 'drops the least recently used keys that have an expiry, and refuses new writes once none are left',
    tech: 'maxmemory-policy volatile-lru',
  },
  { value: 'noeviction', label: 'Refuse writes', say: 'refuses new writes instead of dropping keys', tech: 'maxmemory-policy noeviction' },
];

export const PERSISTENCE_CHOICES: PolicyChoice<CachePersistence>[] = [
  { value: 'off', label: 'Off', say: 'nothing is saved to disk as it goes, so a restart can come back empty', tech: 'appendonly no · save ""' },
  {
    value: 'rdb',
    label: 'Snapshots',
    say: 'a snapshot goes to disk now and then, so a restart keeps the data up to the last one',
    tech: `appendonly no · ${RDB}`,
  },
  { value: 'aof', label: 'Every write', say: 'every write goes to a log on disk, so a restart keeps the data', tech: `appendonly yes (synced every second) · ${RDB}` },
];

const pick = <T extends string>(xs: PolicyChoice<T>[], v: T): PolicyChoice<T> => xs.find((x) => x.value === v) ?? xs[0]!;

/** The declared policy, defaulting like the service does for an older controller. */
export function policyOf(v: CacheView): { eviction: CacheEvictionPolicy; persistence: CachePersistence } {
  const e = v.evictionPolicy as CacheEvictionPolicy | undefined;
  const p = v.persistence as CachePersistence | undefined;
  return {
    eviction: e && (CACHE_EVICTION_POLICIES as readonly string[]).includes(e) ? e : v.purpose === 'queue' ? 'noeviction' : 'allkeys-lru',
    persistence: p && (CACHE_PERSISTENCE_MODES as readonly string[]).includes(p) ? p : 'aof',
  };
}

/** When it's full: the declared policy's sentence (a queue store says why it can't evict). */
export function evictionWords(v: CacheView): { say: string; tech: string } {
  const c = pick(EVICTION_CHOICES, policyOf(v).eviction);
  return v.purpose === 'queue' && c.value === 'noeviction'
    ? { say: `${c.say}, so no job is lost`, tech: `${c.tech} · a queue store always keeps it` }
    : { say: c.say, tech: c.tech };
}

export function persistenceWords(v: CacheView): { say: string; tech: string } {
  const c = pick(PERSISTENCE_CHOICES, policyOf(v).persistence);
  return { say: c.say, tech: `${c.tech} · --dir /data` };
}

/** Why an eviction choice is unavailable, or null. A queue store must never drop jobs. */
export function evictionDisabled(v: CacheView, choice: CacheEvictionPolicy): string | null {
  return v.purpose === 'queue' && choice !== 'noeviction'
    ? 'A queue store keeps refusing writes when full, or it would drop queued jobs.'
    : null;
}

/** Shown while cache-reconcile is still applying a change (`policyApplied: false`). */
export function applyingWords(v: CacheView): string | null {
  return v.policyApplied === false ? 'Being applied to the running copies.' : null;
}
