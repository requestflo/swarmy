/**
 * JIT git credentials (git-apps): resolve a usable token / deploy key for a
 * connection or repo at the moment of use. GitHub installation tokens are
 * minted from the App key and cached in memory only (≤ 55 min); GitLab OAuth
 * tokens are refreshed before expiry. Nothing here returns to a client.
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
  GITLAB_CALLBACK_PATH,
  gitlabTokenNeedsRefresh,
  isSshGitUrl,
  refreshGitlabToken,
  type FetchLike,
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

/** Resolve a usable token for a connection right now (mint / refresh as needed). */
export async function connectionCredentials(db: DB, conn: ConnectionRow): Promise<GitCredentials> {
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
    const cached = installationTokenCache.get(conn.id);
    if (cached && cached.expiresAt > Date.now())
      return { token: cached.token, tokenUser: 'x-access-token' };
    const jwt = githubAppJwt(app.appId, decryptSecret(app.privateKeyEnc));
    const t = await createInstallationToken(
      gitFetch,
      githubApiBase(app.webBase),
      jwt,
      conn.installationId,
    );
    installationTokenCache.set(conn.id, {
      token: t.token,
      expiresAt: Math.min(Date.now() + TOKEN_REUSE_MS, Date.parse(t.expires_at) - 60_000),
    });
    return { token: t.token, tokenUser: 'x-access-token' };
  }
  if (conn.kind === 'GITLAB' && conn.refreshTokenEnc && conn.clientId && conn.clientSecretEnc) {
    if (gitlabTokenNeedsRefresh(conn.tokenExpiresAt)) {
      const t = await refreshGitlabToken(gitFetch, {
        baseUrl: conn.baseUrl,
        clientId: conn.clientId,
        clientSecret: decryptSecret(conn.clientSecretEnc),
        refreshToken: decryptSecret(conn.refreshTokenEnc),
        redirectUri: `${controllerPublicUrl()}${GITLAB_CALLBACK_PATH}`,
      });
      await db.gitConnection.update({
        where: { id: conn.id },
        data: {
          accessTokenEnc: encryptSecret(t.access_token),
          refreshTokenEnc: encryptSecret(t.refresh_token),
          tokenExpiresAt: new Date((t.created_at + t.expires_in) * 1000),
        },
      });
      return { token: t.access_token, tokenUser: 'oauth2' };
    }
  }
  if (conn.accessTokenEnc)
    return { token: decryptSecret(conn.accessTokenEnc), tokenUser: conn.tokenUser ?? 'oauth2' };
  return {};
}

/** Credentials for one repo: connection token, legacy per-repo token, or deploy key. */
export async function repoCredentials(
  db: DB,
  repo: {
    url: string;
    connectionId: string | null;
    tokenEnc: string | null;
    deployKeyEnc: string | null;
    provider: string;
  },
): Promise<GitCredentials> {
  if (repo.deployKeyEnc && isSshGitUrl(repo.url))
    return { sshKey: decryptSecret(repo.deployKeyEnc) };
  if (repo.connectionId) {
    const conn = await loadConnectionRow(db, repo.connectionId);
    if (conn) return connectionCredentials(db, conn);
  }
  if (repo.tokenEnc) {
    return {
      token: decryptSecret(repo.tokenEnc),
      tokenUser: repo.provider === 'GITLAB' ? 'oauth2' : 'x-access-token',
    };
  }
  return {};
}
