import { describe, expect, test } from 'bun:test';
import type { AppPreview, PreviewRules } from '../gitops-types';
import { branchesWords, dataWords, rulesYaml, ttlLeft } from './previews-model';

const rules: PreviewRules = { enabled: true, branches: ['feature/*'], ttlSeconds: 48 * 3600, resources: 'isolated', data: { from: 'production', scrub: 'db/scrub.sql' } };
const preview = (updatedAt: string, branch?: string): AppPreview => ({ pr: 1, stack: 's', sha: 'x', status: 'applied', url: null, updatedAt, planId: 'p', ...(branch ? { branch } : {}) });

describe('previews in words', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  test('time left counts from the last push', () => {
    expect(ttlLeft(preview('2026-10-23T00:00:00Z'), rules, now)).toBe('36 h left');
    expect(ttlLeft(preview('2026-10-20T00:00:00Z'), rules, now)).toBe('due to be cleaned up');
    expect(ttlLeft(preview('2026-10-23T00:00:00Z', 'feat/x'), { ...rules, ttlSeconds: 0 }, now)).toBe('kept until the branch is deleted');
  });
  test('rules read as sentences', () => {
    expect(branchesWords(rules)).toBe('Pull requests and branches matching feature/*');
    expect(branchesWords({ ...rules, branches: [] })).toBe('Pull requests only');
    expect(branchesWords({ ...rules, enabled: false })).toBe('Off — only the ones you start here');
    expect(dataWords(rules)).toBe('a copy of production’s latest backup, scrubbed by db/scrub.sql');
  });
  test('code is the previews: block', () => {
    expect(rulesYaml(rules)).toEqual({ previews: { enabled: true, ttl: '48h', branches: ['feature/*'], data: { from: 'production', scrub: 'db/scrub.sql' } } });
  });
});
