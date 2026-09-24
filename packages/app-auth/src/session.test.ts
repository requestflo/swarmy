import { beforeEach, describe, expect, test } from 'bun:test';
import { base64UrlEncode, type Jwk } from './jwt';
import { getSession, resetSessionCaches } from './session';

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk), kid, alg: 'EdDSA' };
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${base64UrlEncode(JSON.stringify({ alg: 'EdDSA', kid }))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(input)));
    return `${input}.${base64UrlEncode(sig)}`;
  };
  return { jwk, sign };
}

const exp = () => Math.floor(Date.now() / 1000) + 300;

beforeEach(() => resetSessionCaches());

describe('getSession — Protect my app (proxy JWT)', () => {
  test('verifies X-Swarmy-Jwt against the controller JWKS, audience = request host', async () => {
    const ctl = await keyPair('ctl');
    const token = await ctl.sign({ sub: 'u1', email: 'a@x.dev', name: 'Ada', groups: ['eng'], aud: 'app.example.com', exp: exp() });
    const f = (async (url: string) => {
      expect(url).toBe('http://ctl/jwks');
      return Response.json({ keys: [ctl.jwk] });
    }) as unknown as typeof fetch;
    const s = await getSession(
      { headers: new Headers({ host: 'app.example.com', 'x-swarmy-jwt': token }) },
      { swarmyJwksUrl: 'http://ctl/jwks', fetch: f },
    );
    expect(s?.source).toBe('proxy');
    expect(s?.user).toEqual({ id: 'u1', email: 'a@x.dev', name: 'Ada', groups: ['eng'] });
  });

  test('a token minted for another app is refused', async () => {
    const ctl = await keyPair('ctl');
    const token = await ctl.sign({ sub: 'u1', aud: 'other.example.com', exp: exp() });
    const f = (async () => Response.json({ keys: [ctl.jwk] })) as unknown as typeof fetch;
    const s = await getSession(
      { headers: { host: 'app.example.com:443', 'x-swarmy-jwt': token } },
      { swarmyJwksUrl: 'http://ctl/jwks', fetch: f },
    );
    expect(s).toBeNull();
  });

  test('a forged header (not signed by the controller) is refused', async () => {
    const ctl = await keyPair('ctl');
    const attacker = await keyPair('ctl');
    const token = await attacker.sign({ sub: 'admin', aud: 'app.example.com', exp: exp() });
    const f = (async () => Response.json({ keys: [ctl.jwk] })) as unknown as typeof fetch;
    const s = await getSession({ headers: { host: 'app.example.com', 'x-swarmy-jwt': token } }, { swarmyJwksUrl: 'http://ctl/jwks', fetch: f });
    expect(s).toBeNull();
  });
});

describe('getSession — end-user auth (the app auth service)', () => {
  test('exchanges the session cookie for a JWT once, then serves it from cache', async () => {
    const svc = await keyPair('svc');
    const token = await svc.sign({ sub: 'u9', email: 'b@x.dev', exp: exp() });
    let exchanges = 0;
    const f = (async (url: string, init?: RequestInit) => {
      if (url === 'http://orders_swarmy-auth:3000/auth/jwks') return Response.json({ keys: [svc.jwk] });
      if (url === 'http://orders_swarmy-auth:3000/auth/token') {
        exchanges++;
        expect(new Headers(init?.headers).get('cookie')).toBe('swarmy-auth.session_token=abc');
        return Response.json({ token });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const req = { headers: { cookie: 'swarmy-auth.session_token=abc' } };
    const opts = { authUrl: 'http://orders_swarmy-auth:3000', fetch: f };
    expect((await getSession(req, opts))?.user.id).toBe('u9');
    expect((await getSession(req, opts))?.source).toBe('app');
    expect(exchanges).toBe(1);
  });

  test('a bearer JWT is verified directly; a signed-out cookie yields null', async () => {
    const svc = await keyPair('svc');
    const token = await svc.sign({ sub: 'u3', exp: exp() });
    const f = (async (url: string) => {
      if (url.endsWith('/auth/jwks')) return Response.json({ keys: [svc.jwk] });
      if (url.endsWith('/auth/token')) return new Response('unauthorized', { status: 401 });
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const opts = { authUrl: 'http://svc:3000', fetch: f };
    expect((await getSession({ headers: { authorization: `Bearer ${token}` } }, opts))?.user.id).toBe('u3');
    expect(await getSession({ headers: { cookie: 'x=1' } }, opts)).toBeNull();
    expect(await getSession({ headers: {} }, opts)).toBeNull();
  });
});
