/**
 * Gitea / Forgejo client (the two are API-compatible). `baseUrl` is the
 * instance's web root (`https://git.example.com`, `https://codeberg.org`,
 * or a sub-path install); the REST API lives under `/api/v1`. Auth is a
 * personal access token or an OAuth2 access token — Gitea takes both as
 * `Authorization: token …`.
 *
 * Reading a commit (tree, swarmy.yaml) does NOT go through this API: it runs
 * `git.inspect` on a Builder over HTTPS with the same token, exactly like
 * GitLab. This client lists repos/branches and registers the webhook (HMAC,
 * `X-Gitea-Signature`); feedback writers live in gitea-feedback.ts and the
 * OAuth2 / test-connection calls in gitea-auth.ts.
 */
import { requestJson, type FetchLike, type ProviderBranch, type ProviderRepo } from './types';

/** Token scopes swarmy needs (Gitea ≥ 1.19 scoped tokens; older tokens are all-access). */
export const GITEA_SCOPES = ['write:repository', 'write:issue', 'read:user'] as const;
/** Events swarmy's hook subscribes to (`pull_request` includes synchronize). */
export const GITEA_HOOK_EVENTS = ['push', 'pull_request', 'delete'] as const;

export const giteaBase = (b: string): string => b.replace(/\/+$/, '');
export const giteaApi = (b: string): string => `${giteaBase(b)}/api/v1`;
export const giteaAuth = (token: string): Record<string, string> => ({
  authorization: `token ${token}`,
});
/** `owner/name` → URL path segments, each encoded. */
export const giteaRepoPath = (fullName: string): string =>
  fullName.split('/').map(encodeURIComponent).join('/');

interface GtRepo {
  id: number;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

const toRepo = (r: GtRepo): ProviderRepo => ({
  id: String(r.id),
  fullName: r.full_name,
  cloneUrl: r.clone_url,
  htmlUrl: r.html_url,
  defaultBranch: r.default_branch || 'main',
  private: r.private,
});

/**
 * Repos the token's user owns or can reach through a collaboration or an org
 * team — never every public repo on the instance (Codeberg has thousands).
 */
export async function listGiteaRepos(
  fetchFn: FetchLike,
  baseUrl: string,
  token: string,
  opts: { search?: string } = {},
): Promise<ProviderRepo[]> {
  const me = await requestJson<{ id: number }>(fetchFn, `${giteaApi(baseUrl)}/user`, {
    headers: giteaAuth(token),
  });
  const q = new URLSearchParams({ uid: String(me.id), limit: '50', sort: 'updated', order: 'desc' });
  if (opts.search) q.set('q', opts.search);
  const r = await requestJson<{ data?: GtRepo[] }>(
    fetchFn,
    `${giteaApi(baseUrl)}/repos/search?${q.toString()}`,
    { headers: giteaAuth(token) },
  );
  return (r.data ?? []).map(toRepo);
}

export async function listGiteaBranches(
  fetchFn: FetchLike,
  baseUrl: string,
  token: string,
  fullName: string,
): Promise<ProviderBranch[]> {
  const r = await requestJson<Array<{ name: string; commit: { id: string } }>>(
    fetchFn,
    `${giteaApi(baseUrl)}/repos/${giteaRepoPath(fullName)}/branches?limit=50`,
    { headers: giteaAuth(token) },
  );
  return r.map((b) => ({ name: b.name, sha: b.commit.id }));
}

/** Register swarmy's webhook (JSON, HMAC secret). Needs repo admin. Returns the hook id. */
export async function createGiteaRepoHook(
  fetchFn: FetchLike,
  baseUrl: string,
  token: string,
  fullName: string,
  input: { url: string; secret: string },
): Promise<number> {
  const r = await requestJson<{ id: number }>(
    fetchFn,
    `${giteaApi(baseUrl)}/repos/${giteaRepoPath(fullName)}/hooks`,
    {
      method: 'POST',
      headers: giteaAuth(token),
      body: JSON.stringify({
        type: 'gitea',
        config: { url: input.url, content_type: 'json', secret: input.secret },
        events: GITEA_HOOK_EVENTS,
        branch_filter: '*',
        active: true,
      }),
    },
  );
  return r.id;
}

/** `owner/name` from a clone/html URL on this instance (sub-path installs too); null otherwise. */
export function giteaFullName(url: string, baseUrl: string): string | null {
  try {
    const u = new URL(url);
    const b = new URL(giteaBase(baseUrl));
    if (u.host !== b.host) return null;
    const rest = u.pathname.slice(b.pathname.replace(/\/+$/, '').length);
    const parts = rest.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
    return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}
