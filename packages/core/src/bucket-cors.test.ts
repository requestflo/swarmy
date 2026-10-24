import { describe, expect, it } from 'bun:test';
import { SetBucketCorsInput, checkCorsOrigin, foldCorsRules, isDevOrigin, type CorsRuleView } from './bucket-cors';

const rule = (origin: string, over: Partial<CorsRuleView> = {}): CorsRuleView => ({
  origins: [origin],
  methods: ['GET', 'HEAD', 'PUT'],
  allowedHeaders: ['*'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
  ...over,
});

describe('checkCorsOrigin (what Garage can match)', () => {
  it('normalises exact origins: lower-case, trimmed, no trailing slash', () => {
    expect(checkCorsOrigin(' https://Shop.Northwind.dev/ ', { wildcards: false })).toEqual({ ok: true, origin: 'https://shop.northwind.dev' });
    expect(checkCorsOrigin('http://localhost:3000', { wildcards: false })).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(checkCorsOrigin('*', { wildcards: false })).toEqual({ ok: true, origin: '*' });
  });

  it('subdomain wildcards only on an engine that matches them (Garage v2)', () => {
    expect(checkCorsOrigin('https://*.northwind.dev', { wildcards: true })).toEqual({ ok: true, origin: 'https://*.northwind.dev' });
    const v1 = checkCorsOrigin('https://*.northwind.dev', { wildcards: false });
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.reason).toMatch(/Garage v1/);
  });

  it('refuses paths, missing schemes and stray wildcards', () => {
    for (const bad of ['shop.northwind.dev', 'https://shop.northwind.dev/app', 'ftp://x.dev', 'https://shop*.dev', 'https://*']) {
      expect(checkCorsOrigin(bad, { wildcards: true }).ok).toBe(false);
    }
  });
});

describe('foldCorsRules (one rule per origin → one policy)', () => {
  it('collects origins in order and the methods every rule allows', () => {
    const folded = foldCorsRules([rule('https://shop.northwind.dev'), rule('http://localhost:3000')]);
    expect(folded).toEqual({
      origins: ['https://shop.northwind.dev', 'http://localhost:3000'],
      methods: ['GET', 'HEAD', 'PUT'],
      maxAgeSeconds: 3600,
      uniform: true,
    });
  });

  it('flags rules written outside swarmy that disagree', () => {
    const folded = foldCorsRules([rule('https://a.dev'), rule('https://b.dev', { methods: ['GET'], maxAgeSeconds: null })]);
    expect(folded.uniform).toBe(false);
    expect(folded.origins).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('no rules is an empty policy', () => {
    expect(foldCorsRules([])).toEqual({ origins: [], methods: [], maxAgeSeconds: null, uniform: true });
  });
});

describe('SetBucketCorsInput', () => {
  it('defaults to read methods and an hour of preflight cache', () => {
    expect(SetBucketCorsInput.parse({ bucketId: 'b1', origins: ['https://a.dev'] })).toEqual({
      bucketId: 'b1',
      origins: ['https://a.dev'],
      methods: ['GET', 'HEAD'],
      maxAgeSeconds: 3600,
    });
  });

  it('rejects unknown methods and an over-long cache', () => {
    expect(SetBucketCorsInput.safeParse({ bucketId: 'b1', origins: [], methods: ['PATCH'] }).success).toBe(false);
    expect(SetBucketCorsInput.safeParse({ bucketId: 'b1', origins: [], maxAgeSeconds: 90_000 }).success).toBe(false);
  });

  it('marks a developer machine', () => {
    expect(isDevOrigin('http://localhost:3000')).toBe(true);
    expect(isDevOrigin('https://shop.northwind.dev')).toBe(false);
  });
});
