import { describe, expect, test } from 'bun:test';
import type { PreviewRules } from '../gitops-types';
import { NEVER, blockOf, draftFrom, draftProblem, keepOptions, sleepOptions } from './preview-rules-edit';

const rules: PreviewRules = {
  enabled: true,
  branches: ['feature/*'],
  ttlSeconds: 48 * 3600,
  resources: 'isolated',
  data: { from: 'production', scrub: 'db/scrub.sql' },
  sleepAfterSeconds: 7200,
  baseDomain: 'preview.northwind.dev',
  source: 'dashboard',
};

describe('editing preview rules (board 68)', () => {
  test('the rules round-trip through the form into the previews: block', () => {
    expect(blockOf(draftFrom(rules))).toEqual({
      enabled: true,
      base_domain: 'preview.northwind.dev',
      branches: ['feature/*'],
      ttl: '48h',
      sleep_after: '2h',
      data: { from: 'production', scrub: 'db/scrub.sql' },
    });
  });

  test('choices map to swarmy.yaml keys: PRs only, until closed, never sleeps, empty data, a size cap', () => {
    const d = { ...draftFrom(rules), branches: 'prs' as const, keep: 0, sleep: NEVER, data: 'empty' as const, size: 'small' };
    expect(blockOf(d)).toEqual({ enabled: true, base_domain: 'preview.northwind.dev', ttl: 0, sleep_after: 'never', size: 'small' });
    expect(blockOf({ ...d, branches: 'off' })).toMatchObject({ enabled: false });
  });

  test('a shared-resources app keeps sharing (no data copy to make)', () => {
    expect(blockOf(draftFrom({ ...rules, resources: 'shared', data: undefined }))).toMatchObject({ resources: 'shared' });
  });

  test('says what is wrong before anything is saved', () => {
    expect(draftProblem(draftFrom(rules))).toBeNull();
    expect(draftProblem({ ...draftFrom(rules), baseDomain: '' })).toBe('Previews need an address to live under — set the preview domain.');
    expect(draftProblem({ ...draftFrom(rules), patterns: ' , ' })).toBe('Name at least one branch pattern, like feature/*.');
    expect(draftProblem({ ...draftFrom(rules), scrub: 'db/mask.txt' })).toMatch(/^data\.scrub: /);
  });

  test('a value from the file that is no preset is still offered', () => {
    expect(keepOptions(48 * 3600).map((o) => o.label)).toEqual(['24 h', '48 h', '3 d', '7 d', 'Until closed']);
    expect(sleepOptions(7200).map((o) => o.label)).toEqual(['30 min', '2 h', '8 h', 'Never']);
    // Nothing said yet (an older controller): the 2 h default.
    expect(draftFrom({ ...rules, sleepAfterSeconds: undefined }).sleep).toBe(7200);
    expect(draftFrom(null)).toMatchObject({ branches: 'off', keep: 259_200, sleep: 7200, data: 'empty' });
  });
});
