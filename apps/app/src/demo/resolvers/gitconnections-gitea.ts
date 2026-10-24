import type { DomainResolvers } from '../types';

/**
 * Gitea / Forgejo "Test connection" (`gitConnections.testGitea`) in demo mode.
 * Shapes mirror GiteaTestResult in packages/trpc/src/services/git-gitea.service.ts.
 * A host with "forgejo" or "codeberg" in it answers as Forgejo; a token with
 * "read" in it lacks the write scopes; one with "bad" is refused.
 */
export function demoGiteaTest(input: { baseUrl: string; token?: string }) {
  const host = input.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const forgejo = /forgejo|codeberg/i.test(host);
  const server = forgejo
    ? { flavor: 'forgejo' as const, version: '9.0.3+gitea-1.22.0' }
    : { flavor: 'gitea' as const, version: '1.22.3' };
  if (!input.token) return { ok: true as const, ...server, account: null, canListRepos: false, missingScopes: [] };
  if (/bad/i.test(input.token)) return { ok: false as const, status: 401, error: `${host} refused that token.` };
  const weak = /read/i.test(input.token);
  return {
    ok: true as const,
    ...server,
    account: 'demo-user',
    canListRepos: true,
    missingScopes: weak ? ['write:repository', 'write:issue'] : [],
  };
}

export const gitconnectionsGitea: DomainResolvers = {
  handlers: {
    'gitConnections.testGitea': (i) => demoGiteaTest(i as { baseUrl: string; token?: string }),
  },
};
