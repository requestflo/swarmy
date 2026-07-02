import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  INBOUND_MAX_ATTEMPTS,
  hmacSignature,
  inboundBackoffMs,
  isDeadAfter,
  parseHeadersJson,
  parseInboundTarget,
  parseStripeHeader,
  publicHookUrl,
  verifyGithub,
  verifyHmac,
  verifyInbound,
  verifyStripe,
} from './inboundWebhooks.service';

const SECRET = 'whsec_test_0123456789';
const BODY = '{"event":"invoice.paid","id":"evt_123"}';

const hex = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

describe('verifyHmac (X-Signature: sha256=…)', () => {
  test('accepts the correct signature of the raw body', () => {
    expect(verifyHmac(SECRET, BODY, `sha256=${hex(SECRET, BODY)}`)).toBe(true);
  });

  test('matches the exported signature builder', () => {
    expect(hmacSignature(SECRET, BODY)).toBe(`sha256=${hex(SECRET, BODY)}`);
  });

  test('rejects a signature computed with a different secret', () => {
    expect(verifyHmac(SECRET, BODY, `sha256=${hex('other-secret', BODY)}`)).toBe(false);
  });

  test('rejects when the body was tampered with', () => {
    expect(verifyHmac(SECRET, BODY + ' ', `sha256=${hex(SECRET, BODY)}`)).toBe(false);
  });

  test('fails closed on missing header or secret', () => {
    expect(verifyHmac(SECRET, BODY, null)).toBe(false);
    expect(verifyHmac(SECRET, BODY, undefined)).toBe(false);
    expect(verifyHmac('', BODY, `sha256=${hex(SECRET, BODY)}`)).toBe(false);
  });

  test('rejects a bare hex digest without the sha256= prefix', () => {
    expect(verifyHmac(SECRET, BODY, hex(SECRET, BODY))).toBe(false);
  });
});

describe('verifyGithub (X-Hub-Signature-256)', () => {
  // Vector from GitHub's securing-your-webhooks doc.
  test("matches GitHub's published example vector", () => {
    const secret = "It's a Secret to Everybody";
    const payload = 'Hello, World!';
    const expected =
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(verifyGithub(secret, payload, expected)).toBe(true);
  });

  test('rejects the wrong signature', () => {
    expect(verifyGithub(SECRET, BODY, `sha256=${'0'.repeat(64)}`)).toBe(false);
  });
});

describe('verifyStripe (Stripe-Signature: t=…,v1=…)', () => {
  const now = 1_700_000_000;
  const sign = (t: number, body: string, secret = SECRET): string =>
    hex(secret, `${t}.${body}`);

  test('accepts a fresh, correctly signed payload', () => {
    const header = `t=${now},v1=${sign(now, BODY)}`;
    expect(verifyStripe(SECRET, BODY, header, { nowSeconds: now })).toBe(true);
  });

  test('accepts when one of several v1 signatures matches (key rotation)', () => {
    const header = `t=${now},v1=${sign(now, BODY, 'old-secret')},v1=${sign(now, BODY)}`;
    expect(verifyStripe(SECRET, BODY, header, { nowSeconds: now })).toBe(true);
  });

  test('rejects outside the 300s tolerance window (replay guard)', () => {
    const t = now - 301;
    const header = `t=${t},v1=${sign(t, BODY)}`;
    expect(verifyStripe(SECRET, BODY, header, { nowSeconds: now })).toBe(false);
    // …but accepts right at the edge.
    const edge = now - 300;
    expect(verifyStripe(SECRET, BODY, `t=${edge},v1=${sign(edge, BODY)}`, { nowSeconds: now })).toBe(
      true,
    );
  });

  test('rejects a signature over a different timestamp than the header claims', () => {
    const header = `t=${now},v1=${sign(now - 10, BODY)}`;
    expect(verifyStripe(SECRET, BODY, header, { nowSeconds: now })).toBe(false);
  });

  test('rejects malformed headers', () => {
    expect(verifyStripe(SECRET, BODY, 'not-a-header', { nowSeconds: now })).toBe(false);
    expect(verifyStripe(SECRET, BODY, `v1=${sign(now, BODY)}`, { nowSeconds: now })).toBe(false);
    expect(verifyStripe(SECRET, BODY, `t=${now}`, { nowSeconds: now })).toBe(false);
    expect(verifyStripe(SECRET, BODY, '', { nowSeconds: now })).toBe(false);
  });

  test('parseStripeHeader extracts t and every v1', () => {
    expect(parseStripeHeader('t=123, v1=aa, v1=bb, v0=zz')).toEqual({ t: 123, v1: ['aa', 'bb'] });
    expect(parseStripeHeader('t=abc,v1=aa')).toBeNull();
  });
});

describe('verifyInbound dispatcher', () => {
  test('none always passes, even with no secret', () => {
    expect(verifyInbound('none', null, BODY, {})).toBe(true);
  });

  test('verifying kinds fail closed without a secret', () => {
    expect(verifyInbound('hmac', null, BODY, { 'x-signature': 'sha256=deadbeef' })).toBe(false);
    expect(verifyInbound('github', null, BODY, {})).toBe(false);
    expect(verifyInbound('stripe', null, BODY, {})).toBe(false);
  });

  test('routes each kind to its header', () => {
    const sig = `sha256=${hex(SECRET, BODY)}`;
    expect(verifyInbound('hmac', SECRET, BODY, { 'x-signature': sig })).toBe(true);
    expect(verifyInbound('github', SECRET, BODY, { 'x-hub-signature-256': sig })).toBe(true);
    // hmac must NOT accept the github header (and vice versa).
    expect(verifyInbound('hmac', SECRET, BODY, { 'x-hub-signature-256': sig })).toBe(false);
    const t = Math.floor(Date.now() / 1000);
    const stripe = `t=${t},v1=${hex(SECRET, `${t}.${BODY}`)}`;
    expect(verifyInbound('stripe', SECRET, BODY, { 'stripe-signature': stripe })).toBe(true);
  });
});

describe('backoff schedule (1m, 5m, 15m, 1h, 6h → dead)', () => {
  test('maps attempts-made to the documented delays', () => {
    expect(inboundBackoffMs(1)).toBe(60_000);
    expect(inboundBackoffMs(2)).toBe(300_000);
    expect(inboundBackoffMs(3)).toBe(900_000);
    expect(inboundBackoffMs(4)).toBe(3_600_000);
    expect(inboundBackoffMs(5)).toBe(21_600_000);
  });

  test('clamps out-of-range attempts to the schedule bounds', () => {
    expect(inboundBackoffMs(0)).toBe(60_000);
    expect(inboundBackoffMs(99)).toBe(21_600_000);
  });

  test('goes dead after 6 total attempts (1 initial + 5 retries)', () => {
    expect(INBOUND_MAX_ATTEMPTS).toBe(6);
    expect(isDeadAfter(5)).toBe(false);
    expect(isDeadAfter(6)).toBe(true);
    expect(isDeadAfter(7)).toBe(true);
  });
});

describe('parseInboundTarget (targetJson codec)', () => {
  test('accepts a queue target and defaults the convention to list', () => {
    expect(parseInboundTarget({ kind: 'queue', cacheCluster: 'main', queue: 'events' })).toEqual({
      kind: 'queue',
      cacheCluster: 'main',
      queue: 'events',
      convention: 'list',
    });
    expect(
      parseInboundTarget({ kind: 'queue', cacheCluster: 'shop/main', queue: 'q', convention: 'bullmq' }),
    ).toEqual({ kind: 'queue', cacheCluster: 'shop/main', queue: 'q', convention: 'bullmq' });
  });

  test('accepts http(s) forward targets only', () => {
    expect(parseInboundTarget({ kind: 'forward', url: 'https://api.example.com/hook' })).toEqual({
      kind: 'forward',
      url: 'https://api.example.com/hook',
    });
    expect(parseInboundTarget({ kind: 'forward', url: 'ftp://x' })).toBeNull();
  });

  test('rejects malformed values', () => {
    expect(parseInboundTarget(null)).toBeNull();
    expect(parseInboundTarget('queue')).toBeNull();
    expect(parseInboundTarget({ kind: 'queue', queue: 'q' })).toBeNull();
    expect(parseInboundTarget({ kind: 'forward' })).toBeNull();
    expect(parseInboundTarget({ kind: 'other' })).toBeNull();
  });
});

describe('misc codecs', () => {
  test('publicHookUrl builds the receiver URL (trailing slash tolerant)', () => {
    expect(publicHookUrl('https://ctl.example.com/', 'org1', 'stripe-prod')).toBe(
      'https://ctl.example.com/hooks/i/org1/stripe-prod',
    );
  });

  test('parseHeadersJson lowercases keys and drops non-strings', () => {
    expect(parseHeadersJson({ 'Content-Type': 'application/json', 'X-N': 4 })).toEqual({
      'content-type': 'application/json',
    });
    expect(parseHeadersJson(['a'])).toEqual({});
  });
});
