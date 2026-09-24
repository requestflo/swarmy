import { describe, expect, test } from 'bun:test';
import { base64UrlEncode, decodeJwt, JwtError, verifyJwt, verifyWithJwks, remoteJwks, type Jwk } from './jwt';

async function ed25519(kid = 'k1') {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return { pair, jwk: { ...pub, kid, alg: 'EdDSA', use: 'sig' } as Jwk };
}

async function sign(pair: CryptoKeyPair, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(input)));
  return `${input}.${base64UrlEncode(sig)}`;
}

const NOW = 1_800_000_000_000;
const now = Math.floor(NOW / 1000);

describe('verifyJwt', () => {
  test('accepts a valid EdDSA token and checks audience + issuer', async () => {
    const { pair, jwk } = await ed25519();
    const t = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', aud: 'app.example.com', iss: 'https://ctl', exp: now + 60 });
    const claims = await verifyJwt(t, [jwk], { audience: 'app.example.com', issuer: 'https://ctl', now: NOW });
    expect(claims.sub).toBe('u1');
  });

  test('rejects a tampered payload', async () => {
    const { pair, jwk } = await ed25519();
    const t = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', exp: now + 60 });
    const [h, , s] = t.split('.');
    const forged = `${h}.${base64UrlEncode(JSON.stringify({ sub: 'admin', exp: now + 60 }))}.${s}`;
    await expect(verifyJwt(forged, [jwk], { now: NOW })).rejects.toMatchObject({ code: 'bad-signature' });
  });

  test('rejects a token signed by another key under the same kid', async () => {
    const a = await ed25519('k1');
    const b = await ed25519('k1');
    const t = await sign(b.pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', exp: now + 60 });
    await expect(verifyJwt(t, [a.jwk], { now: NOW })).rejects.toMatchObject({ code: 'bad-signature' });
  });

  test('rejects alg none, unknown kids and alg/key mismatches', async () => {
    const { pair, jwk } = await ed25519();
    const none = `${base64UrlEncode(JSON.stringify({ alg: 'none' }))}.${base64UrlEncode(JSON.stringify({ sub: 'x' }))}.sig`;
    await expect(verifyJwt(none, [jwk], { now: NOW })).rejects.toBeInstanceOf(JwtError);
    const other = await sign(pair, { alg: 'EdDSA', kid: 'nope' }, { sub: 'u1' });
    await expect(verifyJwt(other, [jwk], { now: NOW })).rejects.toMatchObject({ code: 'unknown-key' });
    const hs = await sign(pair, { alg: 'HS256', kid: 'k1' }, { sub: 'u1' });
    await expect(verifyJwt(hs, [jwk], { now: NOW })).rejects.toMatchObject({ code: 'unsupported-alg' });
  });

  test('enforces exp / nbf with clock tolerance', async () => {
    const { pair, jwk } = await ed25519();
    const expired = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', exp: now - 31 });
    await expect(verifyJwt(expired, [jwk], { now: NOW })).rejects.toMatchObject({ code: 'expired' });
    const skewed = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', exp: now - 5 });
    expect((await verifyJwt(skewed, [jwk], { now: NOW })).sub).toBe('u1');
    const future = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', nbf: now + 120 });
    await expect(verifyJwt(future, [jwk], { now: NOW })).rejects.toMatchObject({ code: 'not-yet-valid' });
  });

  test('rejects the wrong audience (a token for another app)', async () => {
    const { pair, jwk } = await ed25519();
    const t = await sign(pair, { alg: 'EdDSA', kid: 'k1' }, { sub: 'u1', aud: 'other.example.com', exp: now + 60 });
    await expect(verifyJwt(t, [jwk], { audience: 'app.example.com', now: NOW })).rejects.toMatchObject({ code: 'bad-audience' });
  });

  test('ES256 tokens verify too', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk), kid: 'e1' };
    const input = `${base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: 'e1' }))}.${base64UrlEncode(JSON.stringify({ sub: 'u2' }))}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input)));
    expect((await verifyJwt(`${input}.${base64UrlEncode(sig)}`, [jwk], { now: NOW })).sub).toBe('u2');
  });

  test('decodeJwt refuses garbage', () => {
    expect(() => decodeJwt('a.b')).toThrow(JwtError);
    expect(() => decodeJwt('!!.!!.!!')).toThrow(JwtError);
  });
});

describe('remote JWKS', () => {
  test('refetches once on an unknown kid (key rotation)', async () => {
    const oldKey = await ed25519('old');
    const newKey = await ed25519('new');
    let served: Jwk[] = [oldKey.jwk];
    let fetches = 0;
    const f = (async () => {
      fetches++;
      return new Response(JSON.stringify({ keys: served }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const jwks = remoteJwks('http://ctl/jwks', { fetch: f, cooldownMs: 0 });
    const t1 = await sign(oldKey.pair, { alg: 'EdDSA', kid: 'old' }, { sub: 'a' });
    expect((await verifyWithJwks(t1, jwks, { now: NOW })).sub).toBe('a');
    served = [newKey.jwk];
    const t2 = await sign(newKey.pair, { alg: 'EdDSA', kid: 'new' }, { sub: 'b' });
    expect((await verifyWithJwks(t2, jwks, { now: NOW })).sub).toBe('b');
    expect(fetches).toBe(2);
  });
});
