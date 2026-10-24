import { describe, expect, it } from 'bun:test';
import { LifecycleRuleInput, SetBucketLifecycleInput, nameLifecycleRules } from './bucket-lifecycle';

describe('LifecycleRuleInput (only what Garage implements)', () => {
  it('a prefix + days rule fills in the defaults', () => {
    expect(LifecycleRuleInput.parse({ prefix: 'tmp/', expireAfterDays: 7 })).toEqual({
      id: null,
      enabled: true,
      prefix: 'tmp/',
      expireAfterDays: 7,
      abortUploadsAfterDays: null,
      expireOnDate: null,
      sizeGreaterThan: null,
      sizeLessThan: null,
    });
  });

  it('a rule must do something, and not delete both by days and on a date', () => {
    expect(LifecycleRuleInput.safeParse({ prefix: 'logs/' }).success).toBe(false);
    expect(LifecycleRuleInput.safeParse({ expireAfterDays: 3, expireOnDate: '2027-01-01' }).success).toBe(false);
    expect(LifecycleRuleInput.safeParse({ abortUploadsAfterDays: 7 }).success).toBe(true);
  });

  it('days are whole and between 1 and 36500', () => {
    for (const d of [0, 1.5, 36_501]) expect(LifecycleRuleInput.safeParse({ expireAfterDays: d }).success).toBe(false);
  });

  it('caps the rule count', () => {
    const rules = Array.from({ length: 21 }, () => ({ expireAfterDays: 1 }));
    expect(SetBucketLifecycleInput.safeParse({ bucketId: 'b', rules }).success).toBe(false);
  });
});

describe('nameLifecycleRules', () => {
  it('names unnamed rules swarmy-<n>, skipping ids already taken', () => {
    const base = LifecycleRuleInput.parse({ expireAfterDays: 1 });
    const named = nameLifecycleRules([{ ...base }, { ...base, id: 'swarmy-2' }, { ...base }]);
    expect(named.map((r) => r.id)).toEqual(['swarmy-1', 'swarmy-2', 'swarmy-3']);
  });
});
