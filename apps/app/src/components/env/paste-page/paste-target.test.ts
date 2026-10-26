import { describe, expect, test } from 'bun:test';
import { envList, planPaste, SHARED, type PasteEnvSide } from './paste-target';

const prod: PasteEnvSide = {
  environment: 'production',
  stack: 'shop',
  serviceId: 'svc-api',
  current: { NODE_ENV: 'production', LOG_LEVEL: 'info', CDN_HOST: 'cdn.shop.dev', OLD_FLAG: '1' },
  declared: { NODE_ENV: 'env.NODE_ENV' },
};
const staging: PasteEnvSide = {
  environment: 'staging',
  stack: 'shop-staging',
  serviceId: 'svc-stg-api',
  current: { NODE_ENV: 'staging', LOG_LEVEL: 'debug', CDN_HOST: 'cdn.shop.dev' },
  declared: { NODE_ENV: 'environments.staging.env.NODE_ENV' },
};
const paste = [
  { key: 'NODE_ENV', value: 'development' },
  { key: 'LOG_LEVEL', value: 'warn' },
  { key: 'CDN_HOST', value: 'cdn2.shop.dev' },
  { key: 'FEATURE_X', value: 'on' },
];
const kinds = (rows: Array<{ key: string; kind: string }>): Record<string, string> => Object.fromEntries(rows.map((r) => [r.key, r.kind]));

describe('planPaste (board 58)', () => {
  test('one environment: a declared variable is locked with its path, the rest merge', () => {
    const [p] = planPaste({ entries: paste, envs: [prod, staging], target: 'staging', mode: 'merge' });
    expect(p!.serviceId).toBe('svc-stg-api');
    expect(kinds(p!.rows)).toEqual({ NODE_ENV: 'locked', LOG_LEVEL: 'changed', CDN_HOST: 'changed', FEATURE_X: 'added' });
    expect(p!.rows.find((r) => r.key === 'NODE_ENV')?.why).toBe('environments.staging.env.NODE_ENV');
    expect(p!.next).toEqual({ NODE_ENV: 'staging', LOG_LEVEL: 'warn', CDN_HOST: 'cdn2.shop.dev', FEATURE_X: 'on' });
    expect(p!.moving).toBe(3);
  });

  test('Replace all removes what the paste leaves out, but never what swarmy.yaml declares', () => {
    const [p] = planPaste({ entries: [{ key: 'LOG_LEVEL', value: 'warn' }], envs: [prod], target: 'production', mode: 'replace' });
    expect(kinds(p!.rows)).toEqual({ NODE_ENV: 'unchanged', LOG_LEVEL: 'changed', CDN_HOST: 'removed', OLD_FLAG: 'removed' });
    expect(p!.next).toEqual({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
  });

  test('every environment: production takes it, an environment with its own value keeps it, merge only', () => {
    const [pp, sp] = planPaste({ entries: paste, envs: [prod, staging], target: SHARED, mode: 'replace' });
    expect(kinds(pp!.rows)).toEqual({ NODE_ENV: 'locked', LOG_LEVEL: 'changed', CDN_HOST: 'changed', OLD_FLAG: 'unchanged', FEATURE_X: 'added' });
    // staging's LOG_LEVEL (debug) differs from production's (info): its override wins over the shared paste.
    expect(kinds(sp!.rows)).toEqual({ NODE_ENV: 'locked', LOG_LEVEL: 'kept', CDN_HOST: 'changed', FEATURE_X: 'added' });
    expect(sp!.rows.find((r) => r.key === 'LOG_LEVEL')?.why).toBe('staging sets its own');
    expect(sp!.next).toEqual({ NODE_ENV: 'staging', LOG_LEVEL: 'debug', CDN_HOST: 'cdn2.shop.dev', FEATURE_X: 'on' });
  });

  test('a paste that only repeats locked values moves nothing', () => {
    const [p] = planPaste({ entries: [{ key: 'NODE_ENV', value: 'x' }], envs: [prod], target: 'production', mode: 'merge' });
    expect(p!.moving).toBe(0);
    expect(p!.next).toEqual(prod.current);
  });

  test('an unknown target plans nothing; names read as a list', () => {
    expect(planPaste({ entries: paste, envs: [prod], target: 'qa', mode: 'merge' })).toEqual([]);
    expect(envList(['production'])).toBe('production');
    expect(envList(['production', 'staging', 'qa'])).toBe('production, staging and qa');
  });
});
