import { describe, expect, test } from 'bun:test';
import type { RouteProtection } from '@swarmy/ingress';
import { compactProtection } from './ingress-routes';

const EMPTY: RouteProtection = { ipAllow: [], ipDeny: [], blockBots: false, requiredHeaders: [] };

describe('compactProtection', () => {
  test('drops a fully-inactive protection', () => {
    expect(compactProtection(EMPTY)).toBeUndefined();
  });

  test('keeps the classic fields', () => {
    const out = compactProtection({ ...EMPTY, ipDeny: ['10.0.0.0/8'], blockBots: true });
    expect(out?.ipDeny).toEqual(['10.0.0.0/8']);
    expect(out?.blockBots).toBe(true);
  });

  // Regression: these fields were once stripped here, so cache/geo/WAF config
  // never survived persistence to the swarmy.ingress.routes label and never
  // reached the renderer.
  test('carries cache, country rules, and waf through to the persisted route', () => {
    const waf = { blockScannerPaths: true, blockMethods: [], denyQueryPatterns: [] };
    const out = compactProtection({
      ...EMPTY,
      cache: { ttlSeconds: 60 },
      countryAllow: ['GB', 'US'],
      waf,
    });
    expect(out?.cache).toEqual({ ttlSeconds: 60 });
    expect(out?.countryAllow).toEqual(['GB', 'US']);
    expect(out?.waf).toEqual(waf);
  });

  test('any one of the new fields alone makes the protection active', () => {
    expect(compactProtection({ ...EMPTY, cache: { ttlSeconds: 30 } })).toBeDefined();
    expect(compactProtection({ ...EMPTY, countryDeny: ['RU'] })).toBeDefined();
    expect(
      compactProtection({
        ...EMPTY,
        waf: { blockScannerPaths: false, blockMethods: ['TRACE'], denyQueryPatterns: [] },
      }),
    ).toBeDefined();
    // empty arrays stay inactive
    expect(compactProtection({ ...EMPTY, countryAllow: [] })).toBeUndefined();
  });
});
