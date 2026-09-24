import { describe, expect, it } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  buildGithubManifest,
  defaultAppName,
  githubApiBase,
  githubAppJwt,
  githubFullName,
  githubManifestFormUrl,
  listInstallationRepos,
  upsertCheckRun,
  upsertGithubStickyComment,
} from './github-app';
import {
  gitlabAuthorizeUrl,
  gitlabTokenNeedsRefresh,
  setGitlabCommitStatus,
  upsertGitlabStickyNote,
} from './gitlab';
import { signState, verifyState } from './state';
import { GitProviderError, redactUrl, requestJson, type FetchLike } from './types';

/** A scripted fake fetch: each call pops the next response and is recorded. */
function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{
    url: string;
    method: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  const fn: FetchLike = async (url, init) => {
    const r = responses.shift() ?? { status: 200, body: {} };
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  };
  return { fn, calls };
}

describe('state', () => {
  const key = 'k'.repeat(32);
  it('round-trips and binds purpose + org', () => {
    const t = signState(key, { purpose: 'github-setup', orgId: 'org1', userId: 'u1' }, 1000);
    expect(verifyState(key, t, 'github-setup', 1001)).toMatchObject({
      orgId: 'org1',
      userId: 'u1',
      exp: 1600,
    });
    expect(verifyState(key, t, 'gitlab-oauth', 1001)).toBeNull(); // wrong purpose
    expect(verifyState(key, t, 'github-setup', 1601)).toBeNull(); // expired
    expect(verifyState('x'.repeat(32), t, 'github-setup', 1001)).toBeNull(); // wrong key
    const [body] = t.split('.');
    expect(verifyState(key, `${body}.AAAA`, 'github-setup', 1001)).toBeNull(); // tampered mac
  });
});

describe('github app', () => {
  it('builds a manifest pointing every URL back at the controller', () => {
    const m = buildGithubManifest({ controllerUrl: 'https://swarmy.northwind.dev/' });
    expect(m).toMatchObject({
      name: 'swarmy-swarmy-northwind-dev',
      url: 'https://swarmy.northwind.dev',
      hook_attributes: { url: 'https://swarmy.northwind.dev/webhooks/github', active: true },
      redirect_url: 'https://swarmy.northwind.dev/git/github/manifest/callback',
      callback_urls: ['https://swarmy.northwind.dev/git/github/setup'],
      request_oauth_on_install: true,
      public: false,
      default_permissions: {
        contents: 'read',
        metadata: 'read',
        checks: 'write',
        statuses: 'write',
        pull_requests: 'write',
      },
      default_events: ['push', 'pull_request', 'installation', 'installation_repositories'],
    });
    expect(
      defaultAppName('https://a-very-long-controller-hostname.example.internal').length,
    ).toBeLessThanOrEqual(34);
    expect(githubManifestFormUrl('s t', { githubOrg: 'northwind' })).toBe(
      'https://github.com/organizations/northwind/settings/apps/new?state=s%20t',
    );
  });

  it('maps API bases for github.com and GHES', () => {
    expect(githubApiBase()).toBe('https://api.github.com');
    expect(githubApiBase('https://git.corp.example/')).toBe('https://git.corp.example/api/v3');
  });

  it('signs a verifiable RS256 App JWT', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const jwt = githubAppJwt(12345, pem, 10_000);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: 9940,
      exp: 10540,
      iss: '12345',
    });
    expect(
      createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });

  it('lists installation repos with a search filter and stops at the last page', async () => {
    const repo = (id: number, full: string) => ({
      id,
      full_name: full,
      clone_url: `https://github.com/${full}.git`,
      html_url: `https://github.com/${full}`,
      default_branch: 'main',
      private: true,
    });
    const { fn, calls } = fakeFetch([
      { body: { repositories: [repo(1, 'northwind/orders'), repo(2, 'northwind/web')] } },
    ]);
    const repos = await listInstallationRepos(fn, 'https://api.github.com', 'ghs_x', {
      search: 'ORD',
    });
    expect(repos).toEqual([
      {
        id: '1',
        fullName: 'northwind/orders',
        cloneUrl: 'https://github.com/northwind/orders.git',
        htmlUrl: 'https://github.com/northwind/orders',
        defaultBranch: 'main',
        private: true,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe('token ghs_x');
  });

  it('sticky comment: edits the marked comment instead of posting a new one', async () => {
    const { fn, calls } = fakeFetch([
      {
        body: [
          { id: 7, body: 'lgtm' },
          { id: 9, body: '<!-- swarmy:plan:orders -->\nold' },
        ],
      },
      { body: { id: 9 } },
    ]);
    const id = await upsertGithubStickyComment(
      fn,
      'https://api.github.com',
      't',
      'northwind/orders',
      42,
      'plan:orders',
      'new plan',
    );
    expect(id).toBe(9);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/repos/northwind/orders/issues/42/comments?per_page=100&page=1',
      'PATCH https://api.github.com/repos/northwind/orders/issues/comments/9',
    ]);
    expect(calls[1]?.body).toEqual({ body: '<!-- swarmy:plan:orders -->\nnew plan' });
  });

  it('sticky comment: posts once when none exists', async () => {
    const { fn, calls } = fakeFetch([{ body: [] }, { body: { id: 11 } }]);
    expect(
      await upsertGithubStickyComment(fn, 'https://api.github.com', 't', 'a/b', 1, 'k', 'x'),
    ).toBe(11);
    expect(calls[1]?.method).toBe('POST');
  });

  it('check runs: in-progress then completed with a conclusion', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 5 } }, { body: { id: 5 } }]);
    const id = await upsertCheckRun(fn, 'https://api.github.com', 't', 'a/b', {
      sha: 'abc',
      state: 'running',
      context: 'swarmy / plan',
      description: 'planning',
    });
    await upsertCheckRun(fn, 'https://api.github.com', 't', 'a/b', {
      sha: 'abc',
      state: 'failure',
      context: 'swarmy / plan',
      description: 'blocked',
      summary: 'x postgres…',
      checkRunId: id,
    });
    expect(calls[0]?.body).toMatchObject({
      status: 'in_progress',
      head_sha: 'abc',
      name: 'swarmy / plan',
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/a/b/check-runs/5',
    });
    expect(calls[1]?.body).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'blocked', summary: 'x postgres…' },
    });
  });

  it('parses owner/name from clone and html URLs', () => {
    expect(githubFullName('https://github.com/northwind/orders.git')).toBe('northwind/orders');
    expect(githubFullName('https://github.com/northwind/orders/tree/main')).toBe(
      'northwind/orders',
    );
    expect(githubFullName('https://gitlab.com/northwind/orders')).toBeNull();
  });
});

describe('gitlab', () => {
  it('builds the authorize URL with api scope and state', () => {
    const u = new URL(
      gitlabAuthorizeUrl({
        baseUrl: 'https://git.example/',
        clientId: 'cid',
        redirectUri: 'https://c/git/gitlab/callback',
        state: 'st',
      }),
    );
    expect(u.origin + u.pathname).toBe('https://git.example/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://c/git/gitlab/callback',
      response_type: 'code',
      scope: 'api',
      state: 'st',
    });
  });

  it('maps commit states to GitLab vocabulary', async () => {
    const { fn, calls } = fakeFetch([{ body: {} }]);
    await setGitlabCommitStatus(fn, undefined, 't', '12', {
      sha: 'abc',
      state: 'failure',
      context: 'swarmy / plan',
      description: 'blocked',
    });
    const u = new URL(calls[0]?.url ?? '');
    expect(u.pathname).toBe('/api/v4/projects/12/statuses/abc');
    expect(u.searchParams.get('state')).toBe('failed');
    expect(calls[0]?.headers.authorization).toBe('Bearer t');
  });

  it('sticky MR note edits by marker', async () => {
    const { fn, calls } = fakeFetch([
      { body: [{ id: 3, body: '<!-- swarmy:plan:x -->' }] },
      { body: {} },
    ]);
    expect(await upsertGitlabStickyNote(fn, undefined, 't', 'g/p', 4, 'plan:x', 'b')).toBe(3);
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      url: 'https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/4/notes/3',
    });
  });

  it('refreshes tokens before they expire', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(gitlabTokenNeedsRefresh(null, now)).toBe(true);
    expect(gitlabTokenNeedsRefresh(new Date('2026-01-01T00:01:00Z'), now)).toBe(true);
    expect(gitlabTokenNeedsRefresh(new Date('2026-01-01T01:00:00Z'), now)).toBe(false);
  });
});

describe('requestJson', () => {
  it('surfaces the provider message and never the secret query params', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const err = await requestJson(fn, 'https://gitlab.com/oauth/token?client_secret=shh&x=1').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).status).toBe(401);
    expect((err as Error).message).toBe(
      'GET https://gitlab.com/oauth/token?client_secret=***&x=1 → 401: Bad credentials',
    );
    expect(redactUrl('https://u:pw@h/x?access_token=t')).toBe('https://u:***@h/x?access_token=***');
  });
});
