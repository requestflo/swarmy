import { describe, expect, it } from 'bun:test';
import { fromDraft, summarizeProtection, toDraft, type RouteProtection } from './protection-model';

const FULL: RouteProtection = {
  rateLimit: { requests: 100, windowSeconds: 60, key: 'ip' },
  ipAllow: ['10.0.0.0/8'],
  ipDeny: ['203.0.113.7'],
  bodyMaxSize: '10MB',
  blockBots: true,
  requiredHeaders: [{ name: 'X-Api-Key' }, { name: 'X-Env', value: 'prod' }],
  cache: { ttlSeconds: 300, staleWhileRevalidateSeconds: 60, keyHeaders: ['Accept-Language'] },
  countryAllow: ['GB', 'IE'],
  countryDeny: ['RU'],
  waf: { blockScannerPaths: true, blockMethods: ['TRACE'], denyQueryPatterns: ['(?i)union.*select'] },
};

describe('protection draft mapping — cache / country / waf', () => {
  it('round-trips a fully-populated protection through the draft unchanged', () => {
    expect(fromDraft(toDraft(FULL))).toEqual(FULL);
  });

  it('an empty draft folds to null (nothing enforced)', () => {
    expect(fromDraft(toDraft(null))).toBeNull();
  });

  it('cache off in the draft drops the cache fragment', () => {
    const d = toDraft(FULL);
    const p = fromDraft({ ...d, cacheOn: false });
    expect(p?.cache).toBeUndefined();
  });

  it('country codes are uppercased and tokenised from comma/space input', () => {
    const d = toDraft(null);
    const p = fromDraft({ ...d, countryAllow: 'gb, ie', countryDeny: 'ru kp' });
    expect(p?.countryAllow).toEqual(['GB', 'IE']);
    expect(p?.countryDeny).toEqual(['RU', 'KP']);
  });

  it('empty country inputs stay ABSENT (compacted), not empty arrays', () => {
    const d = toDraft(null);
    const p = fromDraft({ ...d, blockBots: true });
    expect(p?.countryAllow).toBeUndefined();
    expect(p?.countryDeny).toBeUndefined();
  });

  it('waf on with defaults keeps blockScannerPaths true and empty lists', () => {
    const d = toDraft(null);
    const p = fromDraft({ ...d, wafOn: true });
    expect(p?.waf).toEqual({ blockScannerPaths: true, blockMethods: [], denyQueryPatterns: [] });
  });

  it('waf methods uppercase; query patterns split per line', () => {
    const d = toDraft(null);
    const p = fromDraft({ ...d, wafOn: true, wafMethods: 'trace, delete', wafQueryPatterns: 'a.*b\nc+' });
    expect(p?.waf?.blockMethods).toEqual(['TRACE', 'DELETE']);
    expect(p?.waf?.denyQueryPatterns).toEqual(['a.*b', 'c+']);
  });

  it('stale-while-revalidate only carries when a positive number is entered', () => {
    const d = toDraft(null);
    const noStale = fromDraft({ ...d, cacheOn: true, cacheTtlSeconds: 120, cacheStaleSeconds: '' });
    expect(noStale?.cache).toEqual({ ttlSeconds: 120 });
    const withStale = fromDraft({ ...d, cacheOn: true, cacheTtlSeconds: 120, cacheStaleSeconds: '30' });
    expect(withStale?.cache).toEqual({ ttlSeconds: 120, staleWhileRevalidateSeconds: 30 });
  });

  it('summarize chips include cache/country/waf', () => {
    const chips = summarizeProtection(FULL);
    expect(chips).toContain('cache 300s');
    expect(chips).toContain('3 country rules');
    expect(chips).toContain('WAF-lite');
  });
});
