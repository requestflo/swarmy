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
