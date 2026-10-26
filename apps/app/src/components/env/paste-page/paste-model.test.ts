import { describe, expect, test } from 'bun:test';
import { diffEnv, parseDotenv, SERVICE_ENV_KEY } from '@swarmy/core';
import { changeGroups, changeSummary, lineMarks } from './paste-model';
import { planPaste } from './paste-target';

const TEXT = [
  '# exported',
  'export NODE_ENV=production',
  "STRIPE_SECRET_KEY='sk_live_abcdef1234567890'",
  '2FA_MODE=on',
  'LOG_LEVEL=info',
  'LOG_LEVEL=debug',
].join('\n');

describe('the paste page over the shared parser', () => {
  const parsed = parseDotenv(TEXT, { keyPattern: SERVICE_ENV_KEY, keyRule: 'UPPER_SNAKE_CASE' });
  test('a skipped line is an error mark, a duplicate a warning', () => {
    const marks = lineMarks(parsed.warnings);
    expect(marks.get(4)).toBe('error');
    expect(marks.get(6)).toBe('warn');
  });
  test('secrets detected come out of added/changed; removed only on replace', () => {
    const current = { NODE_ENV: 'staging', OLD_HOST: 'x' };
    const merge = changeGroups(diffEnv(current, parsed.entries, 'merge').rows, new Set());
    expect(merge.map((g) => `${g.key}:${g.rows.map((r) => r.key).join(',')}`)).toEqual([
      'secrets:STRIPE_SECRET_KEY',
      'added:LOG_LEVEL',
      'changed:NODE_ENV',
    ]);
    const replace = changeGroups(diffEnv(current, parsed.entries, 'replace').rows, new Set(['LOG_LEVEL']));
    expect(replace.map((g) => g.key)).toEqual(['secrets', 'changed', 'removed']);
  });
  test('summary', () => {
    const d = diffEnv({ A: '1', B: '2' }, [{ key: 'A', value: '1' }], 'merge');
    expect(changeSummary(d.rows, new Set(['A']), 1, false)).toBe('+0 added · 0 changed · 1 same · 1 not in the paste · 1 note');
  });
  test('locked and kept rows get their own groups and counts; Replace all counts only real removals', () => {
    const [p] = planPaste({
      entries: [{ key: 'NODE_ENV', value: 'dev' }, { key: 'B', value: '3' }],
      envs: [{ environment: 'production', stack: 'shop', serviceId: 's', current: { NODE_ENV: 'production', B: '2', C: '1', D: '4' }, declared: { NODE_ENV: 'env.NODE_ENV', D: 'env.D' } }],
      target: 'production',
      mode: 'replace',
    });
    expect(changeGroups(p!.rows, new Set()).map((g) => `${g.key}:${g.rows.map((r) => r.key).join(',')}`)).toEqual(['changed:B', 'removed:C', 'locked:NODE_ENV']);
    expect(changeSummary(p!.rows, new Set(['NODE_ENV', 'B']), 0, true)).toBe('+0 added · 1 changed · 0 same · 1 removed · 1 locked · 0 notes');
  });
});
