import { describe, expect, it } from 'bun:test';
import {
  adaptDirectHttpRequest,
  adaptDirectHttpResponse,
  authTrustedOrigins,
  directHttpHost,
  downgradeSetCookie,
} from './origins';

const HTTPS = 'https://swarmy.46-101-22-121.sslip.io';
const DIRECT = 'http://46.101.22.121:3021';
const ENV = { CONTROLLER_PUBLIC_URL: HTTPS, BETTER_AUTH_URL: HTTPS, SWARMY_DIRECT_URL: DIRECT };

describe('authTrustedOrigins', () => {
  it('trusts BOTH the https dashboard domain and the direct http://<ip>:3021', () => {
    const o = authTrustedOrigins(ENV);
    expect(o).toContain(HTTPS);
    expect(o).toContain(DIRECT);
    expect(o).toContain('http://localhost:3023');
    expect(new Set(o).size).toBe(o.length);
  });

  it('unchanged default when nothing is configured', () => {
    expect(authTrustedOrigins({})).toEqual(['http://localhost:3021', 'http://localhost:3023']);
  });

  it('normalises to origins (paths/trailing slashes dropped) and ignores junk', () => {
    expect(authTrustedOrigins({ CONTROLLER_PUBLIC_URL: `${HTTPS}/`, SWARMY_DIRECT_URL: 'not a url' })).toEqual([
      HTTPS,
      'http://localhost:3023',
    ]);
  });
});

describe('directHttpHost', () => {
  it('set only when the auth base is https and the direct URL is http', () => {
    expect(directHttpHost(ENV)).toBe('46.101.22.121:3021');
    expect(directHttpHost({ ...ENV, BETTER_AUTH_URL: DIRECT })).toBeNull();
    expect(directHttpHost({ BETTER_AUTH_URL: HTTPS })).toBeNull();
    expect(directHttpHost({ BETTER_AUTH_URL: HTTPS, SWARMY_DIRECT_URL: HTTPS })).toBeNull();
  });
});

describe('mixed-origin cookies', () => {
  const host = '46.101.22.121:3021';

  it('direct http request: swarmy.* cookies gain the __Secure- prefix Better Auth reads', () => {
    const req = new Request(`${DIRECT}/api/trpc/x`, {
      headers: { host, cookie: 'swarmy.session_token=abc; other=1; __Secure-swarmy.session_data=spoof' },
    });
    const out = adaptDirectHttpRequest(req, host);
    expect(out.headers.get('cookie')).toBe('__Secure-swarmy.session_token=abc; other=1');
  });

  it('https (Caddy) request is untouched', () => {
    const req = new Request(`${DIRECT}/api/trpc/x`, {
      headers: { host: 'swarmy.46-101-22-121.sslip.io', cookie: '__Secure-swarmy.session_token=abc' },
    });
    expect(adaptDirectHttpRequest(req, host)).toBe(req);
    const res = new Response('ok', { headers: { 'set-cookie': '__Secure-swarmy.session_token=x; Path=/; Secure' } });
    expect(adaptDirectHttpResponse(req, res, host)).toBe(res);
  });

  it('no direct host configured → no-op', () => {
    const req = new Request(`${DIRECT}/`, { headers: { host, cookie: 'swarmy.session_token=abc' } });
    expect(adaptDirectHttpRequest(req, null)).toBe(req);
  });

  it('direct http response: Set-Cookie loses the prefix and Secure, keeps the rest', async () => {
    const req = new Request(`${DIRECT}/api/auth/sign-in/email`, { headers: { host } });
    const headers = new Headers();
    headers.append('set-cookie', '__Secure-swarmy.session_token=tok; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax');
    headers.append('set-cookie', '__Secure-swarmy.session_data=d; Path=/; HttpOnly; Secure; SameSite=Lax');
    const out = adaptDirectHttpResponse(req, new Response('{}', { status: 200, headers }), host);
    expect(out.headers.getSetCookie()).toEqual([
      'swarmy.session_token=tok; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
      'swarmy.session_data=d; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(await out.text()).toBe('{}');
  });

  it('downgradeSetCookie leaves plain cookies alone', () => {
    expect(downgradeSetCookie('a=1; Path=/')).toBe('a=1; Path=/');
  });
});
