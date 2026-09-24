import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { createServer } from './server';
import { base64UrlEncode, verifyJwt, type Jwk } from './jwt';

const dir = mkdtempSync(join(tmpdir(), 'app-auth-test-'));
const APP = 'http://shop.localhost';
let srv: Awaited<ReturnType<typeof createServer>>;
let ctl: ReturnType<typeof Bun.serve>;
let sign: (claims: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  // A stand-in swarmy controller JWKS (admin calls are controller-signed).
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk), kid: 'ctl', alg: 'EdDSA' };
  sign = async (claims) => {
    const input = `${base64UrlEncode(JSON.stringify({ alg: 'EdDSA', kid: 'ctl' }))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(input)));
    return `${input}.${base64UrlEncode(sig)}`;
  };
  ctl = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  srv = await createServer(
    loadConfig({
      AUTH_APP_URL: APP,
      AUTH_HOSTS: 'shop.localhost',
      AUTH_EMAIL: 'password',
      AUTH_ALLOWED_DOMAINS: 'acme.dev',
      AUTH_SQLITE_PATH: join(dir, 'auth.sqlite'),
      AUTH_SECRETS_DIR: join(dir, 'secrets'),
      SWARMY_STACK: 'shop',
      SWARMY_JWKS_URL: `http://localhost:${ctl.port}/jwks`,
    }),
  );
});
afterAll(() => {
  ctl?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  srv.fetch(
    new Request(`${APP}${path}`, {
      ...init,
      headers: { origin: APP, 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) },
    }),
  );

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

describe('swarmy-app-auth', () => {
  it('reports its providers and email mode', async () => {
    expect(await (await call('/auth/swarmy/providers')).json()).toEqual({ providers: [], email: 'password' });
  });

  it('password sign-up → session cookie → /auth/token JWT that verifies against /auth/jwks', async () => {
    const up = await call('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ email: 'ada@acme.dev', password: 'correct-horse-9', name: 'Ada' }) });
    expect(up.status).toBe(200);
    const cookie = cookieOf(up);
    expect(cookie).toContain('swarmy-auth.session_token=');
    const tok = (await (await call('/auth/token', { cookie })).json()) as { token: string };
    const jwks = (await (await call('/auth/jwks')).json()) as { keys: Jwk[] };
    const claims = await verifyJwt(tok.token, jwks.keys, { audience: APP, issuer: APP });
    expect(claims.email).toBe('ada@acme.dev');
    expect(claims.name).toBe('Ada');
  });

  it('allowedDomains refuses sign-up from other domains', async () => {
    const up = await call('/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ email: 'eve@evil.dev', password: 'correct-horse-9', name: 'Eve' }) });
    expect(up.status).toBeGreaterThanOrEqual(400);
  });

  it('admin API needs a controller-signed JWT for THIS stack', async () => {
    expect((await call('/auth/swarmy/admin/users')).status).toBe(403);
    const exp = Math.floor(Date.now() / 1000) + 60;
    const other = await sign({ aud: 'swarmy-app-auth:billing', scope: 'app-auth:admin', exp });
    expect((await call('/auth/swarmy/admin/users', { headers: { authorization: `Bearer ${other}` } })).status).toBe(403);
    const token = await sign({ aud: 'swarmy-app-auth:shop', scope: 'app-auth:admin', exp });
    const auth = { authorization: `Bearer ${token}` };
    const list = (await (await call('/auth/swarmy/admin/users', { headers: auth })).json()) as { total: number; users: { id: string; email: string; disabled: boolean }[] };
    expect(list.total).toBe(1);
    const ada = list.users[0]!;
    expect(ada).toMatchObject({ email: 'ada@acme.dev', disabled: false });

    // disable → sessions revoked and sign-in refused
    const off = await call(`/auth/swarmy/admin/users/${ada.id}/disable`, { method: 'POST', headers: auth });
    expect(off.status).toBe(200);
    const signIn = await call('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: 'ada@acme.dev', password: 'correct-horse-9' }) });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    await call(`/auth/swarmy/admin/users/${ada.id}/enable`, { method: 'POST', headers: auth });
    const again = await call('/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: 'ada@acme.dev', password: 'correct-horse-9' }) });
    expect(again.status).toBe(200);
  });

  it('serves the hosted sign-in page', async () => {
    const res = await call('/auth/login?callbackURL=/orders');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Sign in to shop');
  });
});
