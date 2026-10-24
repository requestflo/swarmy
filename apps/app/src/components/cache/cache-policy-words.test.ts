import { describe, expect, test } from 'bun:test';
import { CACHE_EVICTION_POLICIES, CACHE_PERSISTENCE_MODES } from '@swarmy/core';
import {
  EVICTION_CHOICES,
  PERSISTENCE_CHOICES,
  applyingWords,
  evictionDisabled,
  evictionWords,
  persistenceWords,
  policyOf,
} from './cache-policy-words';
import type { CacheView } from './cache-words';

const view = (over: Partial<CacheView> = {}): CacheView =>
  ({
    stack: 'shop',
    name: 'main',
    purpose: 'cache',
    evictionPolicy: 'allkeys-lru',
    persistence: 'aof',
    policyApplied: true,
    ...over,
  }) as CacheView;

describe('when full + persistence words', () => {
  test('one choice per policy the service accepts, in its order', () => {
    expect(EVICTION_CHOICES.map((c) => c.value)).toEqual([...CACHE_EVICTION_POLICIES]);
    expect(PERSISTENCE_CHOICES.map((c) => c.value)).toEqual([...CACHE_PERSISTENCE_MODES]);
  });

  test('the sentence follows the declared policy', () => {
    expect(evictionWords(view()).say).toBe('drops the least recently used keys first');
    expect(evictionWords(view({ evictionPolicy: 'noeviction' })).tech).toBe('maxmemory-policy noeviction');
    expect(persistenceWords(view({ persistence: 'off' })).say).toContain('a restart can come back empty');
    expect(persistenceWords(view({ persistence: 'rdb' })).tech).toContain('appendonly no');
  });

  test('a queue store never evicts, and says why the other choices are off', () => {
    const q = view({ purpose: 'queue', evictionPolicy: 'noeviction' });
    expect(evictionWords(q).say).toBe('refuses new writes instead of dropping keys, so no job is lost');
    expect(evictionDisabled(q, 'allkeys-lru')).toContain('queued jobs');
    expect(evictionDisabled(q, 'noeviction')).toBeNull();
    expect(evictionDisabled(view(), 'volatile-lru')).toBeNull();
  });

  test('an older controller without the fields reads as the old fixed behaviour', () => {
    const old = view({ evictionPolicy: undefined, persistence: undefined, policyApplied: undefined } as never);
    expect(policyOf(old)).toEqual({ eviction: 'allkeys-lru', persistence: 'aof' });
    expect(policyOf({ ...old, purpose: 'queue' })).toEqual({ eviction: 'noeviction', persistence: 'aof' });
    expect(applyingWords(old)).toBeNull();
  });

  test('says when a change is still being applied', () => {
    expect(applyingWords(view({ policyApplied: false }))).toBe('Being applied to the running copies.');
    expect(applyingWords(view())).toBeNull();
  });
});
