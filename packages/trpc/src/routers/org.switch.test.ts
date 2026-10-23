import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildAuth, type Auth } from '@swarmy/auth';
import { createTestDb, type TestDb } from '@swarmy/db';
import { createContext } from '../context';
import type { AgentHub } from '../hub/types';
import { appRouter } from '../root';

/**
 * Regression: `org.switchOrg` called Better Auth server-side and dropped the
 * Set-Cookie it re-issues. The browser kept the old `session_data` cookie
 * cache (cookieCache.maxAge 60 s), so the next request still read the
 * previous org. The switch must hand the refreshed cookies to the response.
 */

/** Fold Set-Cookie headers into a Cookie request header (name=value only). */
function cookieJar(prev: string, headers: Headers): string {
  const jar = new Map(prev.split('; ').filter(Boolean).map((kv) => [kv.split('=')[0]!, kv] as const));
  for (const sc of headers.getSetCookie()) {
    const kv = sc.split(';')[0]!;
    const name = kv.split('=')[0]!;
    if (/max-age=0/i.test(sc) || kv.endsWith('=')) jar.delete(name);
    else jar.set(name, kv);
  }
  return [...jar.values()].join('; ');
}

describe('org.switchOrg refreshes the session cookie cache', () => {
  let store: TestDb;
  let auth: Auth;
  let cookie = '';
  let orgA = '';
  let orgB = '';

  const activeOrg = async (c: string): Promise<string | null | undefined> =>
    (await auth.api.getSession({ headers: new Headers({ cookie: c }) }))?.session.activeOrganizationId;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-000';
    process.env.SWARMY_AUTH_RATE_LIMIT = '0';
    store = await createTestDb();
    auth = buildAuth({ social: {} }, { db: store.db });
    const up = await auth.api.signUpEmail({
      body: { email: 'switch@example.com', password: 'correct-horse-battery', name: 'Switcher' },
      returnHeaders: true,
    });
    cookie = cookieJar('', up.headers);
    for (const slug of ['org-a', 'org-b']) {
      const r = await auth.api.createOrganization({
        body: { name: slug, slug },
        headers: new Headers({ cookie }),
        returnHeaders: true,
      });
      cookie = cookieJar(cookie, r.headers);
      if (slug === 'org-a') orgA = r.response!.id;
      else orgB = r.response!.id;
    }
    // Land on org B the way the sign-up flow does (client-side, cookies kept).
    const set = await auth.api.setActiveOrganization({
      body: { organizationId: orgB },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    cookie = cookieJar(cookie, set.headers);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
  });

  it('the next request reads the new org, not the cached one', async () => {
    expect(await activeOrg(cookie)).toBe(orgB);

    const resHeaders = new Headers();
    const ctx = await createContext({
      headers: new Headers({ cookie }),
      db: store.db,
      hub: {} as AgentHub,
      auth,
      resHeaders,
    });
    expect(ctx.activeOrgId).toBe(orgB);
    expect(await appRouter.createCaller(ctx).org.switchOrg({ orgId: orgA })).toEqual({ activeOrgId: orgA });

    // The stale cookie still carries org B: that's the cache the fix refreshes.
    expect(await activeOrg(cookie)).toBe(orgB);
    expect(resHeaders.getSetCookie().some((c) => c.includes('session_data='))).toBe(true);
    const next = cookieJar(cookie, resHeaders);
    expect(await activeOrg(next)).toBe(orgA);

    const nextCtx = await createContext({ headers: new Headers({ cookie: next }), db: store.db, hub: {} as AgentHub, auth });
    expect(await appRouter.createCaller(nextCtx).org.whoami()).toMatchObject({ activeOrgId: orgA });
  });

  it('refuses an org the person is not a member of, without touching cookies', async () => {
    const other = await store.db.organization.create({
      data: { id: 'org_x', name: 'x', slug: 'x', createdAt: new Date() },
    });
    const resHeaders = new Headers();
    const ctx = await createContext({ headers: new Headers({ cookie }), db: store.db, hub: {} as AgentHub, auth, resHeaders });
    await expect(appRouter.createCaller(ctx).org.switchOrg({ orgId: other.id })).rejects.toThrow('not a member');
    expect(resHeaders.getSetCookie()).toEqual([]);
  });
});
