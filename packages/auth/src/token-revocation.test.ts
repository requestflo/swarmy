import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { buildAuth } from './server';
import { isTokenRevoked, onSessionDeleted, sessionsRevokedSince, type RevocationDb } from './token-revocation';

/** Fold Set-Cookie headers into a Cookie request header (name=value only). */
function cookieOf(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((kv) => !kv.endsWith('='))
    .join('; ');
}

describe('sign-out and session revocation end API tokens and OAuth grants', () => {
  let store: TestDb;
  let db: DB;
  let auth: ReturnType<typeof buildAuth>;
  const email = 'owner@example.com';
  const password = 'correct-horse-battery';

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-000';
    process.env.SWARMY_AUTH_RATE_LIMIT = '0';
    store = await createTestDb();
    db = store.db;
    auth = buildAuth({ social: {} }, { db });
    await db.oidcClient.create({ data: { id: 'c1', clientId: 'swarmy-mcp' } });
  }, 60_000);
  afterAll(async () => store?.close());

  async function signIn(): Promise<{ cookie: string; sessionId: string }> {
    const res = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const cookie = cookieOf(res.headers);
    const s = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return { cookie, sessionId: s!.session.id };
  }

  async function grant(id: string, userId: string, sessionId: string | null) {
    await db.oidcRefreshToken.create({ data: { id, token: `rt_${id}`, clientId: 'swarmy-mcp', userId, sessionId } });
    await db.oidcAccessToken.create({
      data: { id: `at_${id}`, token: `at_${id}`, clientId: 'swarmy-mcp', userId, sessionId, refreshId: id },
    });
  }

  const grants = async () => (await db.oidcRefreshToken.findMany({ orderBy: { id: 'asc' } })).map((r) => r.id);

  it('sign-out stamps tokensRevokedAt and ends only that session’s grants', async () => {
    await auth.api.signUpEmail({ body: { email, password, name: 'Owner' } });
    const user = (await db.user.findUnique({ where: { email } }))!;
    const a = await signIn();
    const b = await signIn();
    await grant('ga', user.id, a.sessionId);
    await grant('gb', user.id, b.sessionId);
    await grant('gorphan', user.id, null);
    const before = Date.now();

    await auth.api.signOut({ headers: new Headers({ cookie: a.cookie }) });

    const stamped = (await db.user.findUnique({ where: { id: user.id } }))!.tokensRevokedAt;
    expect(stamped).toBeInstanceOf(Date);
    expect(isTokenRevoked(Math.floor(before / 1000) - 1, stamped)).toBe(true);
    expect(await grants()).toEqual(['gb', 'gorphan']);
    expect(await db.oidcAccessToken.count({ where: { refreshId: 'ga' } })).toBe(0);
    expect(sessionsRevokedSince(user.id, before)).toBe(true);
  });

  it('"sign out everywhere" ends every grant the user holds', async () => {
    const c = await signIn();
    await auth.api.revokeSessions({ headers: new Headers({ cookie: c.cookie }) });
    expect(await grants()).toEqual([]);
    expect(await db.oidcAccessToken.count()).toBe(0);
  });
});

describe('onSessionDeleted', () => {
  function fakeDb(log: string[]): RevocationDb {
    const op = (name: string) => async (args: unknown) => void log.push(`${name} ${JSON.stringify(args)}`);
    return {
      user: { updateMany: op('user') },
      oidcAccessToken: { deleteMany: op('access') },
      oidcRefreshToken: { deleteMany: op('refresh') },
    } as unknown as RevocationDb;
  }

  it('ignores Better Auth cleaning up an already-expired session', async () => {
    const log: string[] = [];
    await onSessionDeleted(fakeDb(log))({ id: 's1', userId: 'u1', expiresAt: new Date(Date.now() - 1000) });
    expect(log).toEqual([]);
  });

  it('scopes a single sign-out to its session; /revoke-sessions takes them all', async () => {
    const log: string[] = [];
    const future = new Date(Date.now() + 60_000);
    await onSessionDeleted(fakeDb(log))({ id: 's1', userId: 'u1', expiresAt: future }, { path: '/sign-out' });
    expect(log[1]).toBe('access {"where":{"userId":"u1","sessionId":"s1"}}');
    log.length = 0;
    await onSessionDeleted(fakeDb(log))({ id: 's1', userId: 'u1', expiresAt: future }, { path: '/revoke-sessions' });
    expect(log[1]).toBe('access {"where":{"userId":"u1"}}');
  });
});

describe('isTokenRevoked', () => {
  it('compares JWT seconds to the stamp, failing closed', () => {
    const stamp = new Date(10_500);
    expect(isTokenRevoked(9, null)).toBe(false);
    expect(isTokenRevoked(10, stamp)).toBe(true);
    expect(isTokenRevoked(11, stamp)).toBe(false);
    expect(isTokenRevoked(undefined, stamp)).toBe(true);
  });
});
