/**
 * GitLab client (gitlab.com or self-managed via `baseUrl`). Two auth modes:
 *   - OAuth application (admin pastes client id/secret once; users authorize;
 *     refresh token kept in the vault), scope `api`.
 *   - A project/group access token (fallback), same API surface.
 * swarmy creates the project webhook itself with a random secret token, which
 * the receiver compares constant-time (`X-Gitlab-Token`).
 */
import {
  requestJson,
  stickyMarker,
  type CommitStatusInput,
  type FetchLike,
  type ProviderBranch,
  type ProviderRepo,
} from './types';

export const GITLAB_WEB = 'https://gitlab.com';
export const GITLAB_OAUTH_SCOPE = 'api';
export const GITLAB_CALLBACK_PATH = '/git/gitlab/callback';

const base = (b?: string) => (b ?? GITLAB_WEB).replace(/\/+$/, '');
const api = (b?: string) => `${base(b)}/api/v4`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export function gitlabAuthorizeUrl(input: {
  baseUrl?: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GITLAB_OAUTH_SCOPE,
    state: input.state,
  });
  return `${base(input.baseUrl)}/oauth/authorize?${q.toString()}`;
}

export interface GitlabTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

export function exchangeGitlabCode(
  fetchFn: FetchLike,
  input: {
    baseUrl?: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
): Promise<GitlabTokens> {
  return requestJson<GitlabTokens>(fetchFn, `${base(input.baseUrl)}/oauth/token`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
  });
}

export function refreshGitlabToken(
  fetchFn: FetchLike,
  input: {
    baseUrl?: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    redirectUri: string;
  },
): Promise<GitlabTokens> {
  return requestJson<GitlabTokens>(fetchFn, `${base(input.baseUrl)}/oauth/token`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: input.redirectUri,
    }),
  });
}

/** Refresh when fewer than `skewSec` seconds remain. */
export function gitlabTokenNeedsRefresh(
  expiresAt: Date | null,
  now = new Date(),
  skewSec = 120,
): boolean {
  return !expiresAt || expiresAt.getTime() - now.getTime() < skewSec * 1000;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  web_url: string;
  default_branch: string | null;
  visibility: string;
}

export async function listGitlabProjects(
  fetchFn: FetchLike,
  baseUrl: string | undefined,
  token: string,
  opts: { search?: string } = {},
): Promise<ProviderRepo[]> {
  const q = new URLSearchParams({
    membership: 'true',
    per_page: '100',
    order_by: 'last_activity_at',
    simple: 'true',
  });
  if (opts.search) q.set('search', opts.search);
  const r = await requestJson<GlProject[]>(fetchFn, `${api(baseUrl)}/projects?${q.toString()}`, {
    headers: auth(token),
  });
  return r.map((p) => ({
    id: String(p.id),
    fullName: p.path_with_namespace,
    cloneUrl: p.http_url_to_repo,
    htmlUrl: p.web_url,
    defaultBranch: p.default_branch ?? 'main',
    private: p.visibility !== 'public',
  }));
}

export async function listGitlabBranches(
  fetchFn: FetchLike,
  baseUrl: string | undefined,
  token: string,
  projectId: string,
): Promise<ProviderBranch[]> {
  const r = await requestJson<{ name: string; commit: { id: string } }[]>(
    fetchFn,
    `${api(baseUrl)}/projects/${encodeURIComponent(projectId)}/repository/branches?per_page=100`,
    { headers: auth(token) },
  );
  return r.map((b) => ({ name: b.name, sha: b.commit.id }));
}

/** Register swarmy's push + MR webhook on a project; returns the hook id. */
export async function createGitlabProjectHook(
  fetchFn: FetchLike,
  baseUrl: string | undefined,
  token: string,
  projectId: string,
  input: { url: string; secretToken: string },
): Promise<number> {
  const r = await requestJson<{ id: number }>(
    fetchFn,
    `${api(baseUrl)}/projects/${encodeURIComponent(projectId)}/hooks`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        url: input.url,
        token: input.secretToken,
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      }),
    },
  );
  return r.id;
}

const GL_STATE: Record<CommitStatusInput['state'], string> = {
  pending: 'pending',
  running: 'running',
  success: 'success',
  failure: 'failed',
  error: 'failed',
};

export async function setGitlabCommitStatus(
  fetchFn: FetchLike,
  baseUrl: string | undefined,
  token: string,
  projectId: string,
  input: CommitStatusInput,
): Promise<void> {
  const q = new URLSearchParams({
    state: GL_STATE[input.state],
    name: input.context,
    description: input.description.slice(0, 255),
  });
  if (input.targetUrl) q.set('target_url', input.targetUrl);
  await requestJson(
    fetchFn,
    `${api(baseUrl)}/projects/${encodeURIComponent(projectId)}/statuses/${input.sha}?${q.toString()}`,
    {
      method: 'POST',
      headers: auth(token),
    },
  );
}

/** Edit swarmy's one MR note (by marker) or create it. Returns the note id. */
export async function upsertGitlabStickyNote(
  fetchFn: FetchLike,
  baseUrl: string | undefined,
  token: string,
  projectId: string,
  mrIid: number,
  key: string,
  body: string,
): Promise<number> {
  const marker = stickyMarker(key);
  const full = `${marker}\n${body}`;
  const root = `${api(baseUrl)}/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
  const notes = await requestJson<{ id: number; body?: string }[]>(
    fetchFn,
    `${root}?per_page=100&sort=asc`,
    {
      headers: auth(token),
    },
  );
  const mine = notes.find((n) => n.body?.includes(marker));
  if (mine) {
    await requestJson(fetchFn, `${root}/${mine.id}`, {
      method: 'PUT',
      headers: auth(token),
      body: JSON.stringify({ body: full }),
    });
    return mine.id;
  }
  const created = await requestJson<{ id: number }>(fetchFn, root, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ body: full }),
  });
  return created.id;
}
