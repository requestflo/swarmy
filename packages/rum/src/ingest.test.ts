import { describe, expect, it } from 'bun:test';
import {
  buildEventRows,
  browserFamily,
  deviceClass,
  isBot,
  normalisePage,
  parseBeacon,
  parseChunkCoordinates,
  parseReplayChunk,
  referrerHost,
  visitorHash,
  MAX_BATCH_BYTES,
} from './ingest';
import { signRumToken, verifyRumToken, type RumTokenClaims } from './token';
import { TokenBuckets } from './ratelimit';
import { readRumSettings, serializeRumSettings, replayActive, RUM_SETTINGS_LABEL } from './settings';

const SECRET = 'test-secret';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const now = new Date('2026-09-24T12:00:00.000Z');
const privacy: RumTokenClaims = { o: 'org_1', a: 'shop', m: 'a', s: 0, r: 14 };
const identified: RumTokenClaims = { o: 'org_1', a: 'shop', m: 'i', s: 0.5, r: 30 };

describe('app token', () => {
  it('round-trips and rejects tampering', () => {
    const t = signRumToken(SECRET, identified);
    expect(verifyRumToken(SECRET, t)).toEqual(identified);
    expect(verifyRumToken('other', t)).toBeNull();
    const [v, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...identified, o: 'org_2' })).toString('base64url');
    expect(verifyRumToken(SECRET, `${v}.${forged}.${s}`)).toBeNull();
    expect(verifyRumToken(SECRET, `${v}.${p}`)).toBeNull();
    expect(verifyRumToken(SECRET, 'x'.repeat(600))).toBeNull();
    expect(verifyRumToken(SECRET, undefined)).toBeNull();
  });
  it('is Caddyfile-token safe (base64url segments only)', () => {
    expect(signRumToken(SECRET, identified)).toMatch(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
  });
});

describe('beacon parsing', () => {
  it('accepts a valid batch', () => {
    const r = parseBeacon(JSON.stringify({ v: 1, e: [{ t: 'pv', u: 'https://shop.example.com/a?utm_source=news', r: 'https://google.com/', w: 390, ts: now.getTime() }] }));
    expect(r.ok).toBe(true);
  });
  it('rejects bad json, bad shapes, oversized and too-many', () => {
    expect(parseBeacon('{nope')).toMatchObject({ ok: false, status: 400 });
    expect(parseBeacon(JSON.stringify({ v: 2, e: [] }))).toMatchObject({ ok: false, status: 400 });
    expect(parseBeacon(JSON.stringify({ v: 1, e: [{ t: 'xx', u: '/' }] }))).toMatchObject({ ok: false });
    expect(parseBeacon('x'.repeat(MAX_BATCH_BYTES + 1))).toMatchObject({ ok: false, status: 413 });
    const many = { v: 1, e: Array.from({ length: 51 }, () => ({ t: 'pv', u: 'https://a.b/' })) };
    expect(parseBeacon(JSON.stringify(many))).toMatchObject({ ok: false });
  });
  it('rejects a malformed session id', () => {
    expect(parseBeacon(JSON.stringify({ v: 1, e: [{ t: 'pv', u: 'https://a.b/', sid: '../../etc' }] })).ok).toBe(false);
  });
});

describe('bots and normalisation', () => {
  it('drops obvious automation, keeps browsers', () => {
    expect(isBot(CHROME)).toBe(false);
    expect(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isBot('curl/8.4.0')).toBe(true);
    expect(isBot('')).toBe(true);
    const headless = CHROME.replace('Chrome/', 'HeadlessChrome/');
    expect(isBot(headless)).toBe(true);
    expect(isBot(headless, { allowHeadless: true })).toBe(false);
  });
  it('device + browser are coarse', () => {
    expect(deviceClass(390, '')).toBe('mobile');
    expect(deviceClass(800, '')).toBe('tablet');
    expect(deviceClass(1440, '')).toBe('desktop');
    expect(browserFamily(CHROME)).toBe('Chrome');
    expect(browserFamily('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/130.0')).toBe('Firefox');
  });
  it('page URL keeps path + utm only; referrer keeps host only, same-site is direct', () => {
    expect(normalisePage('https://Shop.example.com/cart/?email=a@b.c&utm_source=nl#x')).toEqual({
      host: 'shop.example.com',
      path: '/cart',
      utm: { source: 'nl', medium: '', campaign: '' },
    });
    expect(referrerHost('https://www.google.com/search?q=secret', 'shop.example.com')).toBe('google.com');
    expect(referrerHost('https://shop.example.com/prev', 'shop.example.com')).toBe('');
    expect(referrerHost('not a url', 'x')).toBe('');
  });
  it('visitor hash rotates daily and differs per app', () => {
    const a = visitorHash(SECRET, '2026-09-24', 'o/shop', '1.2.3.4', CHROME);
    expect(visitorHash(SECRET, '2026-09-24', 'o/shop', '1.2.3.4', CHROME)).toBe(a);
    expect(visitorHash(SECRET, '2026-09-25', 'o/shop', '1.2.3.4', CHROME)).not.toBe(a);
    expect(visitorHash(SECRET, '2026-09-24', 'o/blog', '1.2.3.4', CHROME)).not.toBe(a);
    expect(a).toMatch(/^\d+$/);
  });
});

describe('row building enforces the token mode', () => {
  const events = [
    { t: 'pv' as const, u: 'https://shop.example.com/p?utm_campaign=sale', r: 'https://news.ycombinator.com/', w: 1400, ts: now.getTime(), sid: 'abcdefghij1234' },
    { t: 'lv' as const, u: 'https://shop.example.com/p', d: 4200, ts: now.getTime() + 10_000_000, sid: 'abcdefghij1234' },
  ];
  const client = { ip: '203.0.113.9', userAgent: CHROME, country: 'GB', userId: 'user_7', now };
  it('privacy mode drops session + user ids and keeps no IP/UA', () => {
    const rows = buildEventRows(privacy, events, client, SECRET);
    expect(rows[0]).toMatchObject({
      org_id: 'org_1',
      app: 'shop',
      kind: 'pv',
      path: '/p',
      referrer_host: 'news.ycombinator.com',
      utm_campaign: 'sale',
      country: 'GB',
      device: 'desktop',
      browser: 'Chrome',
      session_id: '',
      user_id: '',
      retention_days: 14,
    });
    expect(JSON.stringify(rows)).not.toContain('203.0.113.9');
    expect(JSON.stringify(rows)).not.toContain('Macintosh');
  });
  it('identified mode keeps the session id and the VERIFIED user id', () => {
    const rows = buildEventRows(identified, events, client, SECRET);
    expect(rows[0]!.session_id).toBe('abcdefghij1234');
    expect(rows[0]!.user_id).toBe('user_7');
    expect(rows[1]!.engaged_ms).toBe(4200);
    // A client clock far off is replaced by the server clock.
    expect(rows[1]!.ts).toBe('2026-09-24 12:00:00.000');
  });
  it('bad country codes are dropped', () => {
    expect(buildEventRows(privacy, events, { ...client, country: 'zz1' }, SECRET)[0]!.country).toBe('');
  });
});

describe('replay chunks', () => {
  it('validates coordinates', () => {
    expect(parseChunkCoordinates('abcdefghij1234', '3')).toEqual({ ok: true, value: { sessionId: 'abcdefghij1234', seq: 3 } });
    expect(parseChunkCoordinates('../x', '0').ok).toBe(false);
    expect(parseChunkCoordinates('abcdefghij1234', '-1').ok).toBe(false);
    expect(parseChunkCoordinates('abcdefghij1234', '1.5').ok).toBe(false);
  });
  it('summarises meta, clicks, errors and trace ids', () => {
    const tid = '0af7651916cd43dd8448eb211c80319c';
    const body = JSON.stringify({
      v: 1,
      events: [
        { type: 4, timestamp: 1000, data: { href: 'https://shop.example.com/checkout?x=1', width: 1, height: 1 } },
        { type: 2, timestamp: 1001, data: { node: {} } },
        { type: 3, timestamp: 1500, data: { source: 2, type: 2, id: 5, x: 1, y: 1 } },
        { type: 5, timestamp: 1600, data: { tag: 'swarmy.request', payload: { traceId: tid, status: 500, method: 'POST', url: '/api/pay' } } },
        { type: 5, timestamp: 1700, data: { tag: 'swarmy.error', payload: { message: 'boom' } } },
        { type: 5, timestamp: 1800, data: { tag: 'swarmy.request', payload: { traceId: 'not-hex' } } },
      ],
    });
    const r = parseReplayChunk(body);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.summary).toEqual({
      events: 6,
      startMs: 1000,
      endMs: 1800,
      firstPath: '/checkout',
      clicks: 1,
      errors: 2,
      requests: 2,
      traceIds: [tid],
    });
  });
  it('rejects non-rrweb bodies', () => {
    expect(parseReplayChunk(JSON.stringify({ v: 1, events: [] })).ok).toBe(false);
    expect(parseReplayChunk(JSON.stringify({ v: 1, events: [{ foo: 1 }] })).ok).toBe(false);
    expect(parseReplayChunk('<html>').ok).toBe(false);
  });
});

describe('rate limit', () => {
  it('sheds a burst and refills over time', () => {
    const b = new TokenBuckets({ ratePerSec: 1, burst: 3 });
    const t = 1_000_000;
    expect([b.take('k', t), b.take('k', t), b.take('k', t), b.take('k', t)]).toEqual([true, true, true, false]);
    expect(b.take('k', t + 1000)).toBe(true);
    expect(b.take('other', t)).toBe(true);
  });
  it('stays bounded', () => {
    const b = new TokenBuckets({ ratePerSec: 1, burst: 1, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) b.take(`k${i}`, 0);
    expect(b.size).toBeLessThanOrEqual(100);
  });
});

describe('settings label', () => {
  it('malformed reads as off; serialisation is stable', () => {
    expect(readRumSettings({ [RUM_SETTINGS_LABEL]: '{bad' }).enabled).toBe(false);
    expect(readRumSettings(undefined).mode).toBe('analytics');
    const s = readRumSettings({ [RUM_SETTINGS_LABEL]: JSON.stringify({ enabled: true, mode: 'identified', replaySampleRate: 0.1 }) });
    expect(replayActive(s)).toBe(true);
    expect(serializeRumSettings(s)).toBe(serializeRumSettings(readRumSettings({ [RUM_SETTINGS_LABEL]: serializeRumSettings(s) })));
    expect(readRumSettings({ [RUM_SETTINGS_LABEL]: JSON.stringify({ enabled: true, blockSelectors: ['a"b'] }) }).enabled).toBe(false);
  });
});
