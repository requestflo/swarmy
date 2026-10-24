import { describe, expect, test } from 'bun:test';
import { giteaReady, giteaTestLine } from './git-gitea-model';

describe('gitea card', () => {
  const form = { baseUrl: 'https://git.example.com', token: '', clientId: '', clientSecret: '' };

  test('ready: a server URL plus a token, or the OAuth app id + secret', () => {
    expect(giteaReady('token', form)).toBe(false);
    expect(giteaReady('token', { ...form, token: 'f00dcafe1234' })).toBe(true);
    expect(giteaReady('token', { ...form, baseUrl: 'git.example.com', token: 'f00dcafe1234' })).toBe(false);
    expect(giteaReady('oauth', { ...form, clientId: 'cid' })).toBe(false);
    expect(giteaReady('oauth', { ...form, clientId: 'cid', clientSecret: 's' })).toBe(true);
  });

  test('test connection reads as one sentence with a tone', () => {
    const probe = { ok: true as const, flavor: 'forgejo' as const, version: '9.0.3+gitea-1.22.0', canListRepos: true };
    expect(giteaTestLine({ ...probe, account: 'dana', missingScopes: [] })).toEqual({
      tone: 'ok',
      text: 'Forgejo 9.0.3 · signed in as dana. Your repos are readable.',
    });
    expect(giteaTestLine({ ...probe, account: 'dana', canListRepos: false, missingScopes: ['read:repository'] })).toEqual({
      tone: 'warn',
      text: 'Signed in as dana, but the token is missing read:repository.',
    });
    expect(giteaTestLine({ ...probe, flavor: 'gitea', version: '1.22.3', account: null, missingScopes: [] }).text).toBe(
      'Gitea 1.22.3 answered. Sign in to finish.',
    );
    expect(giteaTestLine({ ok: false, status: 401, error: 'git.example.com refused that token.' })).toEqual({
      tone: 'bad',
      text: 'git.example.com refused that token.',
    });
  });
});
