import { describe, expect, it } from 'bun:test';
import { parseLivePolicy, planCachePolicy, usesPolicyEnv } from './cache-policy-plan';

const TEMPLATED = ['SWARMY_CACHE_POLICY={{index .Service.Labels "swarmy.cache.appliedPolicy"}}'];
const declared = (eviction: string, persistence: string) => ({
  'swarmy.cache.evictionPolicy': eviction,
  'swarmy.cache.persistence': persistence,
});

describe('planCachePolicy — signature-gated on the applied stamp', () => {
  it('steady state: applied == declared (and live agrees) ⇒ none', () => {
    const anchor = declared('volatile-lru', 'rdb');
    const labels = { 'swarmy.cache.appliedPolicy': 'volatile-lru/rdb' };
    expect(planCachePolicy({ labels, env: TEMPLATED, anchorLabels: anchor })).toEqual({ kind: 'none' });
    expect(planCachePolicy({ labels, env: TEMPLATED, anchorLabels: anchor, live: { eviction: 'volatile-lru', aof: false } })).toEqual({ kind: 'none' });
  });

  it('a pre-policy member with default labels everywhere needs nothing (no restart on upgrade)', () => {
    expect(planCachePolicy({ labels: {}, env: [], anchorLabels: {} })).toEqual({ kind: 'none' });
    expect(planCachePolicy({ labels: {}, env: [], anchorLabels: {}, purpose: 'queue' })).toEqual({ kind: 'none' });
  });

  it('a declared change on a templated member: live apply, no rebuild', () => {
    const step = planCachePolicy({ labels: { 'swarmy.cache.appliedPolicy': 'allkeys-lru/aof' }, env: TEMPLATED, anchorLabels: declared('allkeys-lru', 'off') });
    expect(step).toEqual({ kind: 'apply', target: { eviction: 'allkeys-lru', persistence: 'off' }, rebuild: false });
  });

  it('a declared change on a pre-policy member: live apply, then one rebuild (its args hard-code the old policy)', () => {
    const step = planCachePolicy({ labels: {}, env: ['FOO=1'], anchorLabels: declared('volatile-lru', 'aof') });
    expect(step).toEqual({ kind: 'apply', target: { eviction: 'volatile-lru', persistence: 'aof' }, rebuild: true });
  });

  it('live drift on the primary (a restart that reverted, a manual CONFIG SET) is re-applied', () => {
    const labels = { 'swarmy.cache.appliedPolicy': 'allkeys-lru/rdb' };
    const anchor = declared('allkeys-lru', 'rdb');
    expect(planCachePolicy({ labels, env: TEMPLATED, anchorLabels: anchor, live: { eviction: 'allkeys-lru', aof: true } })).toMatchObject({ kind: 'apply', rebuild: false });
    expect(planCachePolicy({ labels, env: TEMPLATED, anchorLabels: anchor, live: { eviction: 'noeviction', aof: false } })).toMatchObject({ kind: 'apply' });
    // Drift back to the default on a pre-policy member: live apply, no rebuild needed.
    expect(planCachePolicy({ labels: {}, env: [], anchorLabels: {}, live: { eviction: 'volatile-lru', aof: true } })).toEqual({
      kind: 'apply',
      target: { eviction: 'allkeys-lru', persistence: 'aof' },
      rebuild: false,
    });
  });
});

describe('INFO + env readers', () => {
  it('reads maxmemory_policy and aof_enabled from an INFO dump', () => {
    const info = '# Memory\r\nused_memory:1\r\nmaxmemory_policy:volatile-lru\r\n# Persistence\r\naof_enabled:1\r\n';
    expect(parseLivePolicy(info)).toEqual({ eviction: 'volatile-lru', aof: true });
    expect(parseLivePolicy('used_memory:1')).toBeNull();
    expect(parseLivePolicy('maxmemory_policy:noeviction\naof_enabled:x')).toBeNull();
  });

  it('knows a member built with the template env', () => {
    expect(usesPolicyEnv(TEMPLATED)).toBe(true);
    expect(usesPolicyEnv(['SWARMY_CACHE_POLICYX=1'])).toBe(false);
    expect(usesPolicyEnv(undefined)).toBe(false);
  });
});
