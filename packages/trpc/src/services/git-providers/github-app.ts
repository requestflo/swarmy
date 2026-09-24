/**
 * GitHub App client (git-apps Phase 2). One App per swarmy controller,
 * registered by the operator in one click via GitHub's manifest flow — no
 * swarmy cloud, no shared App. Installations are bound to swarmy orgs.
 *
 * Flow:
 *   1. `buildGithubManifest` → the dashboard POSTs it (form field `manifest`) to
 *      `githubManifestFormUrl(...)?state=<signed>`.
 *   2. GitHub redirects to `/git/github/manifest/callback?code&state` →
 *      `convertManifest(code)` → { id, slug, pem, webhook_secret, client_id, client_secret }.
 *   3. The operator installs the App → GitHub runs user OAuth
 *      (`request_oauth_on_install`) and redirects to `/git/github/setup?code&installation_id&state`
 *      → `exchangeOAuthCode` → `listUserInstallations` proves the installing
 *      user can see that installation before it is bound to the org.
 *   4. At dispatch: `githubAppJwt` → `createInstallationToken` (1 h, never stored).
 *
 * Pure over an injected `fetch`; RS256 JWT via node:crypto.
 */
import { createSign } from 'node:crypto';
import {
  GitProviderError,
  requestJson,
  stickyMarker,
  type CommitStatusInput,
  type FetchLike,
  type ProviderBranch,
  type ProviderRepo,
} from './types';

export const GITHUB_WEB = 'https://github.com';

/** REST base for github.com or a GitHub Enterprise Server web URL. */
export function githubApiBase(webBase: string = GITHUB_WEB): string {
  const w = webBase.replace(/\/+$/, '');
  return w === GITHUB_WEB ? 'https://api.github.com' : `${w}/api/v3`;
}

/** Controller paths the App points back at (mounted in apps/api). */
export const GITHUB_PATHS = {
  webhook: '/webhooks/github',
  manifestCallback: '/git/github/manifest/callback',
  setup: '/git/github/setup',
} as const;

export const GITHUB_APP_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  checks: 'write',
  statuses: 'write',
  pull_requests: 'write',
} as const;

export const GITHUB_APP_EVENTS = [
  'push',
  'pull_request',
  'installation',
  'installation_repositories',
] as const;

/** GitHub caps App names at 34 characters and requires global uniqueness. */
export function defaultAppName(controllerUrl: string): string {
  let host = 'swarmy';
  try {
    host = new URL(controllerUrl).hostname.replace(/\./g, '-');
  } catch {
    // keep default
  }
  return `swarmy-${host}`.slice(0, 34).replace(/-+$/, '');
}

export function buildGithubManifest(input: { controllerUrl: string; name?: string }) {
  const base = input.controllerUrl.replace(/\/+$/, '');
  return {
    name: (input.name ?? defaultAppName(base)).slice(0, 34),
    url: base,
    hook_attributes: { url: `${base}${GITHUB_PATHS.webhook}`, active: true },
    redirect_url: `${base}${GITHUB_PATHS.manifestCallback}`,
    callback_urls: [`${base}${GITHUB_PATHS.setup}`],
    // Run user OAuth right after install so the setup callback can prove the
    // installing user actually owns the installation (org-binding safety).
    request_oauth_on_install: true,
    setup_on_update: true,
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: [...GITHUB_APP_EVENTS],
  };
}

/** Where the dashboard POSTs the manifest form (personal account, or an org). */
export function githubManifestFormUrl(
  state: string,
  opts: { webBase?: string; githubOrg?: string } = {},
): string {
  const web = (opts.webBase ?? GITHUB_WEB).replace(/\/+$/, '');
  const path = opts.githubOrg
    ? `/organizations/${encodeURIComponent(opts.githubOrg)}/settings/apps/new`
    : '/settings/apps/new';
  return `${web}${path}?state=${encodeURIComponent(state)}`;
}

/** The install page for the App (the operator picks repos there). */
export function githubInstallUrl(
  appSlug: string,
  state: string,
  webBase: string = GITHUB_WEB,
): string {
  return `${webBase.replace(/\/+$/, '')}/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export interface ConvertedManifest {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  owner?: { login: string };
}

export function convertManifest(
  fetchFn: FetchLike,
  apiBase: string,
  code: string,
): Promise<ConvertedManifest> {
  return requestJson<ConvertedManifest>(
    fetchFn,
    `${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json' },
    },
  );
}

/** RS256 App JWT (valid 9 min, back-dated 60 s for clock skew — GitHub's guidance). */
export function githubAppJwt(
  appId: number | string,
  privateKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem).toString('base64url');
  return `${unsigned}.${sig}`;
}

const ghHeaders = (token: string, kind: 'Bearer' | 'token' = 'Bearer') => ({
  authorization: `${kind} ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

export interface InstallationToken {
  token: string;
  expires_at: string;
}

export function createInstallationToken(
  fetchFn: FetchLike,
  apiBase: string,
  appJwt: string,
  installationId: string | number,
): Promise<InstallationToken> {
  return requestJson<InstallationToken>(
    fetchFn,
    `${apiBase}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: ghHeaders(appJwt),
    },
  );
}

export interface GithubInstallation {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: 'all' | 'selected';
}

export function getInstallation(
  fetchFn: FetchLike,
  apiBase: string,
  appJwt: string,
  installationId: string | number,
) {
  return requestJson<GithubInstallation>(
    fetchFn,
    `${apiBase}/app/installations/${installationId}`,
    {
      headers: ghHeaders(appJwt),
    },
  );
}

/** User-to-server OAuth (the install-time OAuth for org binding). */
export async function exchangeOAuthCode(
  fetchFn: FetchLike,
  input: { webBase?: string; clientId: string; clientSecret: string; code: string },
): Promise<string> {
  const web = (input.webBase ?? GITHUB_WEB).replace(/\/+$/, '');
  const res = await requestJson<{
    access_token?: string;
    error?: string;
    error_description?: string;
  }>(fetchFn, `${web}/login/oauth/access_token`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    }),
  });
  if (!res.access_token)
    throw new GitProviderError(401, res.error_description ?? res.error ?? 'oauth exchange failed');
  return res.access_token;
}

/** Installation ids the USER token can see — the proof step before binding an install to an org. */
export async function listUserInstallationIds(
  fetchFn: FetchLike,
  apiBase: string,
  userToken: string,
): Promise<number[]> {
  const out: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await requestJson<{ installations: { id: number }[] }>(
      fetchFn,
      `${apiBase}/user/installations?per_page=100&page=${page}`,
      { headers: ghHeaders(userToken) },
    );
    out.push(...r.installations.map((i) => i.id));
    if (r.installations.length < 100) break;
  }
  return out;
}

interface GhRepo {
  id: number;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}
const toRepo = (r: GhRepo): ProviderRepo => ({
  id: String(r.id),
  fullName: r.full_name,
  cloneUrl: r.clone_url,
  htmlUrl: r.html_url,
  defaultBranch: r.default_branch,
  private: r.private,
});

/** Repos an installation token can see (the repo picker), optionally filtered by a search string. */
export async function listInstallationRepos(
  fetchFn: FetchLike,
  apiBase: string,
  installationToken: string,
  opts: { search?: string; maxPages?: number } = {},
): Promise<ProviderRepo[]> {
  const out: ProviderRepo[] = [];
  const q = opts.search?.toLowerCase();
  for (let page = 1; page <= (opts.maxPages ?? 10); page++) {
    const r = await requestJson<{ repositories: GhRepo[] }>(
      fetchFn,
      `${apiBase}/installation/repositories?per_page=100&page=${page}`,
      { headers: ghHeaders(installationToken, 'token') },
    );
    out.push(
      ...r.repositories.map(toRepo).filter((x) => !q || x.fullName.toLowerCase().includes(q)),
    );
    if (r.repositories.length < 100) break;
  }
  return out;
}

export async function listGithubBranches(
  fetchFn: FetchLike,
  apiBase: string,
  token: string,
  fullName: string,
): Promise<ProviderBranch[]> {
  const r = await requestJson<{ name: string; commit: { sha: string } }[]>(
    fetchFn,
    `${apiBase}/repos/${fullName}/branches?per_page=100`,
    { headers: ghHeaders(token, 'token') },
  );
  return r.map((b) => ({ name: b.name, sha: b.commit.sha }));
}

// ── feedback: check runs, statuses, sticky PR comment ───────────────────────

const CHECK_CONCLUSION: Record<CommitStatusInput['state'], string | undefined> = {
  pending: undefined,
  running: undefined,
  success: 'success',
  failure: 'failure',
  error: 'failure',
};

/** Create-or-complete a check run named `context` on `sha`; returns the check run id. */
export async function upsertCheckRun(
  fetchFn: FetchLike,
  apiBase: string,
  token: string,
  fullName: string,
  input: CommitStatusInput & { summary?: string; checkRunId?: number },
): Promise<number> {
  const conclusion = CHECK_CONCLUSION[input.state];
  const body = {
    name: input.context,
    head_sha: input.sha,
    status: conclusion ? 'completed' : input.state === 'running' ? 'in_progress' : 'queued',
    ...(conclusion ? { conclusion } : {}),
    ...(input.targetUrl ? { details_url: input.targetUrl } : {}),
    output: {
      title: input.description.slice(0, 255),
      summary: (input.summary ?? input.description).slice(0, 65_000),
    },
  };
  const url = input.checkRunId
    ? `${apiBase}/repos/${fullName}/check-runs/${input.checkRunId}`
    : `${apiBase}/repos/${fullName}/check-runs`;
  const r = await requestJson<{ id: number }>(fetchFn, url, {
    method: input.checkRunId ? 'PATCH' : 'POST',
    headers: ghHeaders(token, 'token'),
    body: JSON.stringify(body),
  });
  return r.id;
}

/** Classic commit status (works for tokens without `checks:write`). */
export async function setGithubCommitStatus(
  fetchFn: FetchLike,
  apiBase: string,
  token: string,
  fullName: string,
  input: CommitStatusInput,
): Promise<void> {
  const state = input.state === 'running' ? 'pending' : input.state;
  await requestJson(fetchFn, `${apiBase}/repos/${fullName}/statuses/${input.sha}`, {
    method: 'POST',
    headers: ghHeaders(token, 'token'),
    body: JSON.stringify({
      state,
      context: input.context,
      description: input.description.slice(0, 140),
      ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
    }),
  });
}

/**
 * Edit swarmy's one comment on a PR (found by its hidden marker), or post it
 * the first time — never a new comment per push. Returns the comment id.
 */
export async function upsertGithubStickyComment(
  fetchFn: FetchLike,
  apiBase: string,
  token: string,
  fullName: string,
  prNumber: number,
  key: string,
  body: string,
): Promise<number> {
  const marker = stickyMarker(key);
  const full = `${marker}\n${body}`;
  for (let page = 1; page <= 10; page++) {
    const comments = await requestJson<{ id: number; body?: string }[]>(
      fetchFn,
      `${apiBase}/repos/${fullName}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: ghHeaders(token, 'token') },
    );
    const mine = comments.find((c) => c.body?.includes(marker));
    if (mine) {
      await requestJson(fetchFn, `${apiBase}/repos/${fullName}/issues/comments/${mine.id}`, {
        method: 'PATCH',
        headers: ghHeaders(token, 'token'),
        body: JSON.stringify({ body: full }),
      });
      return mine.id;
    }
    if (comments.length < 100) break;
  }
  const created = await requestJson<{ id: number }>(
    fetchFn,
    `${apiBase}/repos/${fullName}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: ghHeaders(token, 'token'),
      body: JSON.stringify({ body: full }),
    },
  );
  return created.id;
}

/** `owner/name` from a GitHub clone/html URL (null when it isn't one). */
export function githubFullName(url: string, webBase: string = GITHUB_WEB): string | null {
  try {
    const u = new URL(url);
    if (u.host !== new URL(webBase).host) return null;
    const parts = u.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/, '')
      .split('/');
    return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}
