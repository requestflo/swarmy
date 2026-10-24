import { describe, expect, it } from 'bun:test';
import { createGiteaRepoHook, giteaFullName, listGiteaBranches, listGiteaRepos } from './gitea';
import { setGiteaCommitStatus, upsertGiteaStickyComment } from './gitea-feedback';
import type { FetchLike } from './types';

/** Scripted fake fetch: each call pops the next response; every call is recorded. */
function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown; auth?: string }> = [];
  const fn: FetchLike = async (url, init) => {
    const r = responses.shift() ?? { body: {} };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

const BASE = 'https://git.example.com/';
const API = 'https://git.example.com/api/v1';
// Trimmed real shapes from Gitea 1.22 / Forgejo 9.
const ME = { id: 7, login: 'dana', full_name: 'Dana Ops' };
const REPO = {
  id: 42,
  full_name: 'northwind/shop',
  clone_url: 'https://git.example.com/northwind/shop.git',
  ssh_url: 'git@git.example.com:northwind/shop.git',
  html_url: 'https://git.example.com/northwind/shop',
  default_branch: 'trunk',
  private: true,
};

describe('gitea client', () => {
  it('lists only repos the token user can reach (uid search), with a token header', async () => {
    const { fn, calls } = fakeFetch([{ body: ME }, { body: { ok: true, data: [REPO] } }]);
    expect(await listGiteaRepos(fn, BASE, 'tok', { search: 'shop' })).toEqual([
      {
        id: '42',
        fullName: 'northwind/shop',
        cloneUrl: 'https://git.example.com/northwind/shop.git',
        htmlUrl: 'https://git.example.com/northwind/shop',
        defaultBranch: 'trunk',
        private: true,
      },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/user`,
      `${API}/repos/search?uid=7&limit=50&sort=updated&order=desc&q=shop`,
    ]);
    expect(calls.every((c) => c.auth === 'token tok')).toBe(true);
  });

  it('lists branches with head shas, path-encoded', async () => {
    const { fn, calls } = fakeFetch([
      { body: [{ name: 'trunk', commit: { id: 'a'.repeat(40), message: 'x' }, protected: true }] },
    ]);
    expect(await listGiteaBranches(fn, BASE, 'tok', 'north wind/shop')).toEqual([
      { name: 'trunk', sha: 'a'.repeat(40) },
    ]);
    expect(calls[0]?.url).toBe(`${API}/repos/north%20wind/shop/branches?limit=50`);
  });

  it('registers a JSON webhook with the HMAC secret on push, PR and branch delete', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { id: 9, type: 'gitea' } }]);
    const id = await createGiteaRepoHook(fn, BASE, 'tok', 'northwind/shop', {
      url: 'https://swarmy.test/webhooks/git/r1',
      secret: 'whsec_1',
    });
    expect(id).toBe(9);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/repos/northwind/shop/hooks` });
    expect(calls[0]?.body).toEqual({
      type: 'gitea',
      config: { url: 'https://swarmy.test/webhooks/git/r1', content_type: 'json', secret: 'whsec_1' },
      events: ['push', 'pull_request', 'delete'],
      branch_filter: '*',
      active: true,
    });
  });

  it('commit status: running reads as pending; description capped at 255', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { id: 1 } }]);
    await setGiteaCommitStatus(fn, BASE, 'tok', 'northwind/shop', {
      sha: 'b'.repeat(40),
      state: 'running',
      context: 'swarmy / build',
      description: 'x'.repeat(300),
      targetUrl: 'https://swarmy.test/ci/builds/1',
    });
    expect(calls[0]?.url).toBe(`${API}/repos/northwind/shop/statuses/${'b'.repeat(40)}`);
    expect(calls[0]?.body).toEqual({
      state: 'pending',
      context: 'swarmy / build',
      description: 'x'.repeat(255),
      target_url: 'https://swarmy.test/ci/builds/1',
    });
  });

  it('sticky PR comment: edits swarmy’s own comment, else creates one', async () => {
    const mine = { id: 55, body: '<!-- swarmy:plan:r1 -->\nold', user: { login: 'swarmy' } };
    const edit = fakeFetch([{ body: [{ id: 54, body: 'LGTM' }, mine] }, { body: mine }]);
    expect(await upsertGiteaStickyComment(edit.fn, BASE, 't', 'northwind/shop', 3, 'plan:r1', 'new')).toBe(55);
    expect(edit.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/repos/northwind/shop/issues/3/comments`,
      `PATCH ${API}/repos/northwind/shop/issues/comments/55`,
    ]);
    expect(edit.calls[1]?.body).toEqual({ body: '<!-- swarmy:plan:r1 -->\nnew' });

    const create = fakeFetch([{ body: [] }, { status: 201, body: { id: 60 } }]);
    expect(await upsertGiteaStickyComment(create.fn, BASE, 't', 'northwind/shop', 3, 'plan:r1', 'hi')).toBe(60);
    expect(create.calls[1]).toMatchObject({ method: 'POST', url: `${API}/repos/northwind/shop/issues/3/comments` });
  });

  it('derives owner/name from clone URLs on this instance, sub-path installs too', () => {
    expect(giteaFullName('https://git.example.com/northwind/shop.git', BASE)).toBe('northwind/shop');
    expect(giteaFullName('https://corp.dev/gitea/team/app.git', 'https://corp.dev/gitea')).toBe('team/app');
    expect(giteaFullName('https://codeberg.org/team/app', BASE)).toBeNull();
    expect(giteaFullName('git@git.example.com:team/app.git', BASE)).toBeNull();
  });
});
