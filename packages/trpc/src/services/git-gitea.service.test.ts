import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { linkRepo } from './git-connections.service';
import { connectionCredentials, setGitFetchForTests } from './git-credentials';
import { reportCommitStatus, upsertPrComment } from './git-feedback.service';
import { completeGiteaOAuth, createGiteaConnection, testGiteaConnection } from './git-gitea.service';
import type { FetchLike } from './git-providers';

const prevKey = process.env.SWARMY_SECRET_KEY;
beforeAll(() => {
  process.env.SWARMY_SECRET_KEY = 'test-vault-key-0123456789abcdef';
  process.env.CONTROLLER_PUBLIC_URL = 'https://swarmy.test';
});
afterAll(() => {
  process.env.SWARMY_SECRET_KEY = prevKey;
  setGitFetchForTests(null);
});

/** In-memory stand-in for the few Prisma calls these paths make. */
function fakeDb() {
  const t: Record<string, Array<Record<string, unknown>>> = { gitConnection: [], gitRepo: [], auditLog: [] };
  let n = 0;
  const match = (r: Record<string, unknown>, w: Record<string, unknown> = {}) =>
    Object.entries(w).every(([k, v]) => r[k] === v);
  const model = (name: string) => ({
    findFirst: async (a: { where?: Record<string, unknown> }) => t[name]?.find((r) => match(r, a?.where)) ?? null,
    findUnique: async (a: { where: Record<string, unknown> }) => t[name]?.find((r) => match(r, a.where)) ?? null,
    create: async (a: { data: Record<string, unknown> }) => {
      const row = { id: `${name}-${++n}`, createdAt: new Date(), status: 'active', ...a.data };
      t[name]?.push(row);
      return row;
    },
    update: async (a: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(t[name]?.find((r) => r.id === a.where.id) ?? {}, a.data),
  });
  return { db: Object.fromEntries(Object.keys(t).map((k) => [k, model(k)])) as unknown as DB, t };
}

/** Route fake: first route whose key the URL contains (method-prefixed keys win). */
function routes(map: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const fn: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, auth: (init?.headers as Record<string, string>)?.authorization });
    const key = Object.keys(map).find((k) => {
      const [m, path] = k.includes(' ') ? k.split(' ') : [method, k];
      return m === method && url.includes(path ?? k);
    });
    const r = key ? map[key]! : { status: 404, body: { message: 'not found' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

const ctx = (db: DB) => ({ db, user: { id: 'u1' }, activeOrgId: 'org-a' }) as unknown as OrgContext;
const BASE = 'https://codeberg.example';
const SERVER = {
  '/api/v1/version': { body: { version: '9.0.3+gitea-1.22.0' } },
  '/api/v1/user': { body: { id: 7, login: 'dana' } },
  '/api/v1/repos/search': { body: { ok: true, data: [] } },
};

describe('gitea connections', () => {
  it('a token is verified before it is saved, vaulted, and audited without it', async () => {
    const { db, t } = fakeDb();
    setGitFetchForTests(routes(SERVER).fn);
    const r = await createGiteaConnection(ctx(db), { mode: 'token', baseUrl: `${BASE}/`, token: 'gt_secret' });
    expect(r.connection).toMatchObject({ kind: 'gitea', displayName: 'Forgejo · codeberg.example', baseUrl: BASE, account: 'dana' });
    expect(r.authorizeUrl).toBeUndefined();
    expect(String(t.gitConnection?.[0]?.accessTokenEnc)).not.toContain('gt_secret');
    expect(JSON.stringify(t.auditLog)).not.toContain('gt_secret');
    expect(t.auditLog?.[0]).toMatchObject({ action: 'git.connection.add' });

    setGitFetchForTests(routes({ ...SERVER, '/api/v1/user': { status: 401, body: { message: 'bad token' } } }).fn);
    await expect(createGiteaConnection(ctx(db), { mode: 'token', baseUrl: BASE, token: 'nope' })).rejects.toThrow(
      'codeberg.example refused that token.',
    );
    expect(t.gitConnection).toHaveLength(1);
  });

  it('OAuth: pending until the callback trades the code, then refreshes before expiry', async () => {
    const { db, t } = fakeDb();
    setGitFetchForTests(routes(SERVER).fn);
    const r = await createGiteaConnection(ctx(db), { mode: 'oauth', baseUrl: BASE, clientId: 'cid', clientSecret: 'csec' });
    expect(r.connection.status).toBe('pending');
    const url = new URL(r.authorizeUrl ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/login/oauth/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe('https://swarmy.test/git/gitea/callback');

    const tokens = { access_token: 'gto_1', refresh_token: 'gtr_1', expires_in: 3600 };
    const f = routes({ 'POST /login/oauth/access_token': { body: tokens }, ...SERVER });
    setGitFetchForTests(f.fn);
    const deps = { db, hub: {} as never, auth: {} as never };
    await completeGiteaOAuth(deps, { code: 'c', state: url.searchParams.get('state') ?? '' });
    const row = t.gitConnection?.[0] ?? {};
    expect(row).toMatchObject({ status: 'active', account: 'dana' });
    await expect(completeGiteaOAuth(deps, { code: 'c', state: 'forged.state' })).rejects.toThrow(/expired/);

    row.tokenExpiresAt = new Date(Date.now() - 1000); // expired → refresh, store the rotated pair
    setGitFetchForTests(routes({ 'POST /login/oauth/access_token': { body: { ...tokens, access_token: 'gto_2', refresh_token: 'gtr_2' } } }).fn);
    expect(await connectionCredentials(db, row as never)).toEqual({ token: 'gto_2', tokenUser: 'oauth2' });
    expect(String(row.refreshTokenEnc)).not.toContain('gtr_2');
  });

  it('test connection never throws: plain words for a refused server', async () => {
    setGitFetchForTests(routes({}).fn);
    expect(await testGiteaConnection({ baseUrl: BASE, token: 'x' })).toEqual({
      ok: false,
      status: 404,
      error: 'No Gitea or Forgejo API at codeberg.example/api/v1.',
    });
    setGitFetchForTests(async () => Promise.reject(new TypeError('fetch failed')));
    expect(await testGiteaConnection({ baseUrl: BASE })).toMatchObject({ ok: false, error: 'Couldn’t reach codeberg.example.' });
  });
});

describe('gitea repos + feedback', () => {
  const seed = () => {
    const { db, t } = fakeDb();
    t.gitConnection?.push({ id: 'gc1', orgId: 'org-a', kind: 'GITEA', baseUrl: BASE, status: 'active', accessTokenEnc: encryptSecret('tok'), tokenUser: 'git' });
    return { db, t };
  };
  const REPO = { id: '42', fullName: 'northwind/shop', cloneUrl: `${BASE}/northwind/shop.git` };

  it('linking a repo registers the webhook itself; falls back to showing it', async () => {
    const { db, t } = seed();
    const f = routes({ 'POST /api/v1/repos/northwind/shop/hooks': { status: 201, body: { id: 9 } } });
    setGitFetchForTests(f.fn);
    const r = await linkRepo(ctx(db), { connectionId: 'gc1', repo: REPO, branch: 'main' });
    expect(r.webhook).toBeNull();
    expect(t.gitRepo?.[0]?.provider).toBe('GITEA');
    expect(f.calls[0]?.body).toMatchObject({ config: { url: `https://swarmy.test/webhooks/git/${r.id}`, content_type: 'json' } });
    setGitFetchForTests(routes({}).fn); // not a repo admin → 404/403
    const again = await linkRepo(ctx(db), { connectionId: 'gc1', repo: REPO, branch: 'staging' });
    expect(again.webhook?.url).toBe(`https://swarmy.test/webhooks/git/${again.id}`);
  });

  it('reports commit status and the sticky PR comment through the Gitea API', async () => {
    const { db } = seed();
    const f = routes({ '/statuses/': { status: 201, body: {} }, 'GET /issues/4/comments': { body: [] }, 'POST /issues/4/comments': { status: 201, body: { id: 1 } } });
    setGitFetchForTests(f.fn);
    const repo = { id: 'r', url: `${BASE}/northwind/shop.git`, provider: 'GITEA', connectionId: 'gc1', fullName: null, externalRepoId: '42' };
    const sha = 'c'.repeat(40);
    expect(await reportCommitStatus(db, repo, { sha, state: 'success', context: 'swarmy / plan', description: 'ok' })).toBe(true);
    expect(await upsertPrComment(db, repo, { pr: 4, key: 'plan:r', body: 'plan' })).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      `POST /api/v1/repos/northwind/shop/statuses/${sha}`,
      'GET /api/v1/repos/northwind/shop/issues/4/comments',
      'POST /api/v1/repos/northwind/shop/issues/4/comments',
    ]);
    expect(f.calls.every((c) => c.auth === 'token tok')).toBe(true);
  });
});
