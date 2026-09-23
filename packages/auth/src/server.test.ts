import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import { buildAuth } from './server';

describe('buildAuth cookies', () => {
  // Regression: with Better Auth's default `better-auth.*` cookie names, any
  // other Better Auth app on the same host (cookies ignore ports — every
  // `localhost` dev server) overwrote swarmy's session cookie and ejected the
  // user to /login within seconds. See issues/resolved/dashboard-session-dies-under-normal-use.md.
  it('namespaces session cookies under swarmy, not the shared better-auth default', async () => {
    const ctx = await buildAuth(undefined, { db: {} as DB }).$context;
    expect(ctx.authCookies.sessionToken.name).toMatch(/^(__Secure-)?swarmy\.session_token$/);
    expect(ctx.authCookies.sessionData.name).toMatch(/^(__Secure-)?swarmy\.session_data$/);
  });
});

describe('buildAuth on an https dashboard domain with a direct http origin', () => {
  it('issues __Secure- cookies (what origins.ts translates) and trusts both origins', async () => {
    const keys = ['BETTER_AUTH_URL', 'CONTROLLER_PUBLIC_URL', 'SWARMY_DIRECT_URL'] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.BETTER_AUTH_URL = 'https://swarmy.46-101-22-121.sslip.io';
    process.env.CONTROLLER_PUBLIC_URL = 'https://swarmy.46-101-22-121.sslip.io';
    process.env.SWARMY_DIRECT_URL = 'http://46.101.22.121:3021';
    try {
      const ctx = await buildAuth(undefined, { db: {} as DB }).$context;
      expect(ctx.authCookies.sessionToken.name).toBe('__Secure-swarmy.session_token');
      expect(ctx.trustedOrigins).toContain('https://swarmy.46-101-22-121.sslip.io');
      expect(ctx.trustedOrigins).toContain('http://46.101.22.121:3021');
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
});
