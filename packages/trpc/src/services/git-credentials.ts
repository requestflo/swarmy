/**
 * JIT git credentials (git-apps): resolve a usable token / deploy key for a
 * connection or repo at the moment of use. GitHub installation tokens are
 * minted from the App key and cached in memory only (≤ 55 min); GitLab and
 * Gitea/Forgejo OAuth tokens are refreshed before expiry. Nothing here returns to a client.
 *
 * Kept separate from git-connections.service so cicd.service (builds) can
 * import it without a cycle.
 */
import { TRPCError } from '@trpc/server';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import {
  createInstallationToken,
  githubApiBase,
  githubAppJwt,
  GITEA_CALLBACK_PATH,
  giteaTokenExpiry,
  giteaTokenRequest,
  githubFullName,
  GITLAB_CALLBACK_PATH,
  gitlabTokenNeedsRefresh,
  installationTokenKey,
  installationTokenRequest,
  isSshGitUrl,
  refreshGitlabToken,
  remoteHost,
  remoteMatchesConnection,
  type FetchLike,
  type GithubTokenAccess,
  type InstallationTokenRequest,
} from './git-providers';

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Test seam: replace the HTTP client used for provider calls. */
export function setGitFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
  installationTokenCache.clear();
}

/** The provider HTTP client (swappable in tests via `setGitFetchForTests`). */
export const gitFetch: FetchLike = (url, init) => fetchImpl(url, init);

export function controllerPublicUrl(): string {
  return (
    process.env.CONTROLLER_PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    'http://localhost:3021'
  ).replace(/\/+$/, '');
}

// ── JIT credentials ─────────────────────────────────────────────────────────

const installationTokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_REUSE_MS = 55 * 60 * 1000;

export type ConnectionRow = NonNullable<Awaited<ReturnType<typeof loadConnectionRow>>>;
export function loadConnectionRow(db: DB, id: string) {
  return db.gitConnection.findUnique({ where: { id }, include: { githubApp: true } });
}

export interface GitCredentials {
  token?: string;
  tokenUser?: string;
  sshKey?: string;
}

/**
 * What a credential is for. GitHub installation tokens are narrowed to `repo`
 * (`owner/name`) and the permissions of `access` (github-token-scope.ts);
 * the default is the repo picker's metadata-only token. Other providers'
 * tokens can't be narrowed per request, so they ignore it.
 */
export interface CredentialScope {
  repo?: string | null;
  access?: GithubTokenAccess;
}

/** Resolve a usable token for a connection right now (mint / refresh as needed). */
export async function connectionCredentials(
  db: DB,
  conn: ConnectionRow,
  scope: CredentialScope = {},
): Promise<GitCredentials> {
  if (conn.status !== 'active') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${conn.displayName} is not authorized yet.`,
    });
  }
  if (conn.kind === 'GITHUB') {
    const app = conn.githubApp;
    if (!app || !conn.installationId)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'GitHub connection is incomplete.',
      });
    let req: InstallationTokenRequest;
    try {
      req = installationTokenRequest({ access: scope.access ?? 'list', repo: scope.repo });
    } catch (e) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message });
    }
    const key = installationTokenKey(conn.id, req);
    const cached = installationTokenCache.get(key);
    if (cached && cached.expiresAt > Date.now())
      return { token: cached.token, tokenUser: 'x-access-token' };
    const jwt = githubAppJwt(app.appId, decryptSecret(app.privateKeyEnc));
    const t = await createInstallationToken(gitFetch, githubApiBase(app.webBase), jwt, conn.installationId, req);
    if (installationTokenCache.size > 1000) installationTokenCache.clear();
    installationTokenCache.set(key, {
      token: t.token,
      expiresAt: Math.min(Date.now() + TOKEN_REUSE_MS, Date.parse(t.expires_at) - 60_000),
    });
    return { token: t.token, tokenUser: 'x-access-token' };
  }
  const oauth = conn.kind === 'GITLAB' || conn.kind === 'GITEA';
  if (oauth && conn.refreshTokenEnc && conn.clientId && conn.clientSecretEnc) {
    if (gitlabTokenNeedsRefresh(conn.tokenExpiresAt)) {
      const t = await refreshOAuth(conn.kind, {
        baseUrl: conn.baseUrl,
        clientId: conn.clientId,
        clientSecret: decryptSecret(conn.clientSecretEnc),
        refreshToken: decryptSecret(conn.refreshTokenEnc),
      });
      await db.gitConnection.update({
        where: { id: conn.id },
        data: {
          accessTokenEnc: encryptSecret(t.access_token),
          refreshTokenEnc: encryptSecret(t.refresh_token),
          tokenExpiresAt: t.expiresAt,
        },
      });
      return { token: t.access_token, tokenUser: 'oauth2' };
    }
  }
  if (conn.accessTokenEnc)
    return { token: decryptSecret(conn.accessTokenEnc), tokenUser: conn.tokenUser ?? 'oauth2' };
  return {};
}

/** One OAuth refresh round-trip (GitLab or Gitea/Forgejo); refresh tokens rotate, so store the new one. */
async function refreshOAuth(
  kind: string,
  app: { baseUrl: string; clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ access_token: string; refresh_token: string; expiresAt: Date }> {
  if (kind === 'GITEA') {
    const redirectUri = `${controllerPublicUrl()}${GITEA_CALLBACK_PATH}`;
    const t = await giteaTokenRequest(gitFetch, { ...app, redirectUri }, {
      grant_type: 'refresh_token',
      refresh_token: app.refreshToken,
    });
    return { ...t, expiresAt: giteaTokenExpiry(t) };
  }
  const t = await refreshGitlabToken(gitFetch, {
    ...app,
    redirectUri: `${controllerPublicUrl()}${GITLAB_CALLBACK_PATH}`,
  });
  return { ...t, expiresAt: new Date((t.created_at + t.expires_in) * 1000) };
}

/**
 * Refuse to attach a connection's credential to a remote on another host
 * (M7): a crafted clone URL must never carry the org's token elsewhere.
 */
export function assertRemoteOnConnection(url: string, conn: { baseUrl: string; displayName: string }): void {
  if (remoteMatchesConnection(url, conn.baseUrl)) return;
  const host = remoteHost(conn.baseUrl)?.hostname ?? conn.baseUrl;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `${url} is not on ${host} — ${conn.displayName} only reaches repositories there.`,
  });
}

/** Credentials to read one repo: connection token (narrowed to it), legacy per-repo token, or deploy key. */
export async function repoCredentials(
  db: DB,
  repo: {
    url: string;
    connectionId: string | null;
    tokenEnc: string | null;
    deployKeyEnc: string | null;
    provider: string;
    fullName?: string | null;
  },
): Promise<GitCredentials> {
  if (repo.deployKeyEnc && isSshGitUrl(repo.url))
    return { sshKey: decryptSecret(repo.deployKeyEnc) };
  if (repo.connectionId) {
    const conn = await loadConnectionRow(db, repo.connectionId);
    if (conn) {
      assertRemoteOnConnection(repo.url, conn);
      const name = repo.fullName ?? githubFullName(repo.url, conn.baseUrl);
      return connectionCredentials(db, conn, { repo: name, access: 'read' });
    }
  }
  if (repo.tokenEnc) {
    return {
      token: decryptSecret(repo.tokenEnc),
      tokenUser: repo.provider === 'GITLAB' ? 'oauth2' : 'x-access-token',
    };
  }
  return {};
}
