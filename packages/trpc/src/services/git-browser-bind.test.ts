import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { clearGitBindCookie, gitBindCookie, gitBindNonce } from './git-browser-bind';
import { completeGitlabOAuth, createConnection } from './git-connections.service';
import { setGitFetchForTests } from './git-credentials';
import type { FetchLike } from './git-providers';

const ENV = { SWARMY_SECRET_KEY: 'test-vault-key-0123456789abcdef', CONTROLLER_PUBLIC_URL: 'https://swarmy.test' };
const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, ENV));
afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setGitFetchForTests(null);
});

const N = '0123456789abcdef'.repeat(4);

describe('M6: the browser-binding cookie', () => {
  it('is __Host- (Secure, Path=/, no Domain) on an https controller and reads only that flavour', () => {
    expect(gitBindCookie(N)).toBe(`__Host-swarmy-git-bind=${N}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
    expect(clearGitBindCookie()).toBe('__Host-swarmy-git-bind=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    expect(gitBindNonce(`a=1; __Host-swarmy-git-bind=${N}`)).toBe(N);
    // A plain cookie (settable by a sibling subdomain or over http) never counts on https.
    expect(gitBindNonce(`swarmy-git-bind=${N}`)).toBeNull();
    expect(gitBindNonce('__Host-swarmy-git-bind=not-a-nonce')).toBeNull();
    expect(gitBindNonce(undefined)).toBeNull();
  });

  it('falls back to a host-only plain cookie on a plain-http controller (local dev)', () => {
    process.env.CONTROLLER_PUBLIC_URL = 'http://localhost:3021';
    try {
      expect(gitBindCookie(N)).toBe(`swarmy-git-bind=${N}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`);
      expect(gitBindNonce(`swarmy-git-bind=${N}`)).toBe(N);
    } finally {
      process.env.CONTROLLER_PUBLIC_URL = ENV.CONTROLLER_PUBLIC_URL;
    }
  });
});

/** Just the gitConnection + auditLog calls the GitLab OAuth path makes. */
function fakeDb() {
  const t: Record<string, Array<Record<string, unknown>>> = { gitConnection: [], auditLog: [] };
  const match = (r: Record<string, unknown>, w: Record<string, unknown> = {}) =>
    Object.entries(w).every(([k, v]) => r[k] === v);
  const model = (name: string) => ({
    findFirst: async (a: { where?: Record<string, unknown> }) => t[name]?.find((r) => match(r, a?.where)) ?? null,
    create: async (a: { data: Record<string, unknown> }) => {
      const row = { id: `${name}-${(t[name]?.length ?? 0) + 1}`, createdAt: new Date(), status: 'active', ...a.data };
      t[name]?.push(row);
      return row;
    },
    update: async (a: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(t[name]?.find((r) => r.id === a.where.id) ?? {}, a.data),
  });
  return { db: Object.fromEntries(Object.keys(t).map((k) => [k, model(k)])) as unknown as DB, t };
}

describe('M6: GitLab OAuth is bound to the browser that started it', () => {
  it('a grant link opened in another browser is refused; the starter finishes it', async () => {
    const { db, t } = fakeDb();
    const ctx = { db, user: { id: 'u1' }, activeOrgId: 'org-a', resHeaders: new Headers() } as unknown as OrgContext;
    const r = await createConnection(ctx, { kind: 'gitlab', mode: 'oauth', clientId: 'cid', clientSecret: 'csec' });
    const nonce = gitBindNonce(ctx.resHeaders?.getSetCookie()[0]?.split(';')[0]);
    const state = new URL(r.authorizeUrl ?? '').searchParams.get('state') ?? '';
    const fetch: FetchLike = async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/oauth/token')
            ? { access_token: 'gla', refresh_token: 'glr', created_at: 1, expires_in: 7200 }
            : { username: 'dana' },
        ),
      );
    setGitFetchForTests(fetch);
    const deps = { db, hub: {} as never, auth: {} as never };
    await expect(completeGitlabOAuth(deps, { code: 'c', state, browserNonce: null })).rejects.toThrow(
      'This GitLab link expired or was not started in this browser',
    );
    await expect(completeGitlabOAuth(deps, { code: 'c', state, browserNonce: 'a'.repeat(64) })).rejects.toThrow(
      'not started in this browser',
    );
    expect(t.gitConnection?.[0]?.status).toBe('pending');
    await completeGitlabOAuth(deps, { code: 'c', state, browserNonce: nonce });
    expect(t.gitConnection?.[0]).toMatchObject({ status: 'active', account: 'dana' });
  });
});
