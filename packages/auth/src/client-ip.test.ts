import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import {
  CLIENT_IP_HEADER,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
  withClientIp,
} from './client-ip';
import { AUTH_RATE_LIMIT_RULES, buildAuth } from './server';

const loopbackOnly = parseTrustedProxies(undefined);
const edge = parseTrustedProxies('10.0.1.0/24, 127.0.0.1');
const h = (init: Record<string, string> = {}) => new Headers(init);

describe('parseTrustedProxies', () => {
  it('defaults to loopback only — overlay/ingress ranges are not trusted implicitly', () => {
    expect(resolveClientIp('127.0.0.1', h({ 'x-forwarded-for': '203.0.113.9' }), loopbackOnly)).toBe('203.0.113.9');
    expect(resolveClientIp('::1', h({ 'x-forwarded-for': '203.0.113.9' }), loopbackOnly)).toBe('203.0.113.9');
    expect(resolveClientIp('10.0.0.2', h({ 'x-forwarded-for': '203.0.113.9' }), loopbackOnly)).toBe('10.0.0.2');
  });
  it('`none` trusts nothing, not even loopback', () => {
    const none = parseTrustedProxies('none');
    expect(resolveClientIp('127.0.0.1', h({ 'x-forwarded-for': '203.0.113.9' }), none)).toBe('127.0.0.1');
  });
  it('reports malformed entries instead of silently matching', () => {
    const t = parseTrustedProxies('10.0.0.0/8,not-an-ip,10.0.0.0/99, fd00::/8');
    expect(t.invalid).toEqual(['not-an-ip', '10.0.0.0/99']);
    expect(t.nets).toHaveLength(2);
  });
});

describe('resolveClientIp', () => {
  it('direct hit: the socket peer is the client', () => {
    expect(resolveClientIp('198.51.100.7', h(), edge)).toBe('198.51.100.7');
  });
  it('unwraps IPv4-mapped IPv6 socket addresses (Bun dual-stack listener)', () => {
    expect(resolveClientIp('::ffff:198.51.100.7', h(), edge)).toBe('198.51.100.7');
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1');
  });
  it('trusted proxy: takes the rightmost untrusted X-Forwarded-For hop', () => {
    expect(resolveClientIp('10.0.1.5', h({ 'x-forwarded-for': '198.51.100.7' }), edge)).toBe('198.51.100.7');
    // A client-forged leftmost entry is ignored: Caddy appended the real peer.
    expect(resolveClientIp('10.0.1.5', h({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), edge)).toBe(
      '198.51.100.7',
    );
    // Chained trusted proxies are skipped.
    expect(resolveClientIp('10.0.1.5', h({ 'x-forwarded-for': '198.51.100.7, 10.0.1.9' }), edge)).toBe(
      '198.51.100.7',
    );
  });
  it('trusted proxy without X-Forwarded-For falls back to the socket peer', () => {
    expect(resolveClientIp('10.0.1.5', h(), edge)).toBe('10.0.1.5');
  });
  it('a malformed hop stops the walk at the last verified hop', () => {
    expect(resolveClientIp('10.0.1.5', h({ 'x-forwarded-for': '198.51.100.7, garbage' }), edge)).toBe('10.0.1.5');
  });
  it('untrusted peer: X-Forwarded-For is ignored entirely (spoof attempt)', () => {
    expect(resolveClientIp('198.51.100.7', h({ 'x-forwarded-for': '1.2.3.4' }), edge)).toBe('198.51.100.7');
  });
  it('unknown socket peer resolves to null', () => {
    expect(resolveClientIp(undefined, h({ 'x-forwarded-for': '1.2.3.4' }), edge)).toBeNull();
  });
});

describe('withClientIp', () => {
  it('sets the internal header from the socket peer', () => {
    const out = withClientIp(new Request('http://c/api/auth/sign-in/email'), '198.51.100.7', edge);
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe('198.51.100.7');
  });
  it('strips a client-supplied copy of the internal header', () => {
    const req = new Request('http://c/', { headers: { [CLIENT_IP_HEADER]: '9.9.9.9' } });
    expect(withClientIp(req, '198.51.100.7', edge).headers.get(CLIENT_IP_HEADER)).toBe('198.51.100.7');
    // …even when no peer is known: the spoofed value never survives.
    expect(withClientIp(req, undefined, edge).headers.get(CLIENT_IP_HEADER)).toBeNull();
  });
  it('preserves method and body', async () => {
    const req = new Request('http://c/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    const out = withClientIp(req, '198.51.100.7', edge);
    expect(out.method).toBe('POST');
    expect(await out.json()).toEqual({ email: 'a@b.c' });
  });
  it('end to end through Bun.serve: requestIP feeds the header, spoofed copies are dropped', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req, srv) => {
        const out = withClientIp(req, srv.requestIP(req)?.address, parseTrustedProxies('none'));
        return Response.json({ ip: out.headers.get(CLIENT_IP_HEADER), body: await out.text() });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: { [CLIENT_IP_HEADER]: '9.9.9.9', 'x-forwarded-for': '1.2.3.4' },
        body: 'hello',
      });
      expect(await res.json()).toEqual({ ip: '127.0.0.1', body: 'hello' });
    } finally {
      server.stop(true);
    }
  });
});

describe('Better Auth wiring', () => {
  it('reads the client IP only from the internal header', async () => {
    const ctx = await buildAuth(undefined, { db: {} as DB }).$context;
    expect(ctx.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
  });
  it('pins per-IP credential-endpoint limits (sign-in ≤ 10/min)', async () => {
    const ctx = await buildAuth(undefined, { db: {} as DB }).$context;
    expect(ctx.rateLimit.customRules).toMatchObject(AUTH_RATE_LIMIT_RULES);
    const signIn = AUTH_RATE_LIMIT_RULES['/sign-in/**'];
    expect(signIn.max / (signIn.window / 60)).toBeLessThanOrEqual(10);
  });
});
