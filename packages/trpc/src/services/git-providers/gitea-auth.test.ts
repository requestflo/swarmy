import { describe, expect, it } from 'bun:test';
import {
  giteaAuthorizeUrl,
  giteaFlavor,
  giteaTokenExpiry,
  giteaTokenRequest,
  probeGitea,
} from './gitea-auth';
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
// Trimmed real shapes from Gitea 1.22 / Forgejo 9.
const ME = { id: 7, login: 'dana', full_name: 'Dana Ops' };

describe('gitea auth', () => {
  it('builds the authorize URL with swarmy’s scopes and signed state', () => {
    expect(
      giteaAuthorizeUrl({ baseUrl: BASE, clientId: 'cid', redirectUri: 'https://swarmy.test/git/gitea/callback', state: 's.t' }),
    ).toBe(
      'https://git.example.com/login/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fswarmy.test%2Fgit%2Fgitea%2Fcallback&response_type=code&scope=write%3Arepository+write%3Aissue+read%3Auser&state=s.t',
    );
  });

  it('exchanges a code and counts expiry from receipt', async () => {
    const tokens = { access_token: 'gto_a', refresh_token: 'gtr_r', expires_in: 3600, token_type: 'bearer' };
    const { fn, calls } = fakeFetch([{ body: tokens }]);
    const app = { baseUrl: BASE, clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://swarmy.test/cb' };
    expect(await giteaTokenRequest(fn, app, { grant_type: 'authorization_code', code: 'c1' })).toEqual(tokens);
    expect(calls[0]?.url).toBe('https://git.example.com/login/oauth/access_token');
    expect(calls[0]?.body).toEqual({
      client_id: 'cid',
      client_secret: 'sec',
      redirect_uri: 'https://swarmy.test/cb',
      grant_type: 'authorization_code',
      code: 'c1',
    });
    expect(giteaTokenExpiry(tokens, 1_000).getTime()).toBe(3_601_000);
  });

  it('tells Forgejo from Gitea by its version string', () => {
    expect(giteaFlavor('1.22.3')).toBe('gitea');
    expect(giteaFlavor('9.0.3+gitea-1.22.0')).toBe('forgejo');
    expect(giteaFlavor('7.0.0')).toBe('forgejo');
    expect(giteaFlavor(null)).toBe('gitea');
  });

  it('test connection: server, account, and the scopes a token lacks', async () => {
    const ok = fakeFetch([{ body: { version: '9.0.3+gitea-1.22.0' } }, { body: ME }, { body: { ok: true, data: [] } }]);
    expect(await probeGitea(ok.fn, BASE, 'tok')).toEqual({
      flavor: 'forgejo',
      version: '9.0.3+gitea-1.22.0',
      account: 'dana',
      canListRepos: true,
      missingScopes: [],
    });
    const scope403 = { message: 'token does not have at least one of required scope(s): [read:repository]' };
    const weak = fakeFetch([{ body: { version: '1.22.3' } }, { body: ME }, { status: 403, body: scope403 }]);
    expect(await probeGitea(weak.fn, BASE, 'tok')).toMatchObject({
      flavor: 'gitea',
      account: 'dana',
      canListRepos: false,
      missingScopes: ['read:repository'],
    });
    const bad = fakeFetch([{ body: { version: '1.22.3' } }, { status: 401, body: { message: 'user does not exist' } }]);
    await expect(probeGitea(bad.fn, BASE, 'nope')).rejects.toThrow(/401: user does not exist/);
    const anon = fakeFetch([{ body: { version: '1.21.0' } }]);
    expect(await probeGitea(anon.fn, BASE)).toMatchObject({ account: null, canListRepos: false });
    expect(anon.calls).toHaveLength(1);
  });
});
