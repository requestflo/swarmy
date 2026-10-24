/**
 * Gitea / Forgejo auth: an OAuth2 application the admin registers once on
 * their instance (Site/User Settings → Applications → OAuth2), the same shape
 * as GitLab's, plus the read-only probe behind "Test connection".
 *
 * Gitea's token response carries `expires_in` but no `created_at`, so the
 * expiry is computed at receipt. Refresh tokens rotate — always store the new one.
 */
import { GITEA_SCOPES, giteaApi, giteaAuth, giteaBase } from './gitea';
import { GitProviderError, requestJson, type FetchLike } from './types';

export const GITEA_CALLBACK_PATH = '/git/gitea/callback';

export function giteaAuthorizeUrl(input: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GITEA_SCOPES.join(' '),
    state: input.state,
  });
  return `${giteaBase(input.baseUrl)}/login/oauth/authorize?${q.toString()}`;
}

export interface GiteaTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

type TokenGrant =
  | { grant_type: 'authorization_code'; code: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

export function giteaTokenRequest(
  fetchFn: FetchLike,
  input: { baseUrl: string; clientId: string; clientSecret: string; redirectUri: string },
  grant: TokenGrant,
): Promise<GiteaTokens> {
  return requestJson<GiteaTokens>(fetchFn, `${giteaBase(input.baseUrl)}/login/oauth/access_token`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      ...grant,
    }),
  });
}

/** When a just-issued token stops working (no `created_at` from Gitea: count from now). */
export function giteaTokenExpiry(t: Pick<GiteaTokens, 'expires_in'>, now = Date.now()): Date {
  return new Date(now + Math.max(0, t.expires_in) * 1000);
}

export type GiteaFlavor = 'gitea' | 'forgejo';

/** Forgejo reports `9.0.3+gitea-1.22.0`; Gitea itself is still on 1.x. */
export function giteaFlavor(version: string | null): GiteaFlavor {
  if (!version) return 'gitea';
  return /\+gitea-/.test(version) || !/^v?1\./.test(version) ? 'forgejo' : 'gitea';
}

/** The scope list out of Gitea's 403 ("…required scope(s): [read:repository]"), if that's what it was. */
export function missingScopes(e: unknown): string[] {
  if (!(e instanceof GitProviderError) || e.status !== 403) return [];
  const m = /scope\(s\):\s*\[([^\]]*)\]/.exec(e.message);
  return m?.[1] ? m[1].split(/[\s,]+/).filter(Boolean) : [];
}

export interface GiteaProbe {
  flavor: GiteaFlavor;
  version: string | null;
  /** The token's user; null when no token was given. */
  account: string | null;
  /** The token can list the user's repos (read:repository). */
  canListRepos: boolean;
  missingScopes: string[];
}

/**
 * Is this a Gitea/Forgejo server, and what can the token do? Read-only: the
 * version endpoint, `/user`, and one repo search. Throws GitProviderError
 * when the server or the token is refused outright.
 */
export async function probeGitea(
  fetchFn: FetchLike,
  baseUrl: string,
  token?: string,
): Promise<GiteaProbe> {
  const headers = token ? giteaAuth(token) : {};
  const v = await requestJson<{ version?: string }>(fetchFn, `${giteaApi(baseUrl)}/version`, {
    headers,
  });
  const version = typeof v?.version === 'string' ? v.version : null;
  const base = { flavor: giteaFlavor(version), version };
  const none = { ...base, account: null, canListRepos: false, missingScopes: [] as string[] };
  if (!token) return none;
  const me = await scoped(
    requestJson<{ id: number; login: string }>(fetchFn, `${giteaApi(baseUrl)}/user`, { headers }),
  );
  if (Array.isArray(me)) return { ...none, missingScopes: me };
  const repos = await scoped(
    requestJson(fetchFn, `${giteaApi(baseUrl)}/repos/search?uid=${me.id}&limit=1`, { headers }),
  );
  return Array.isArray(repos)
    ? { ...none, account: me.login, missingScopes: repos }
    : { ...none, account: me.login, canListRepos: true };
}

/** A call's result, or the scopes Gitea said the token lacks (any other failure rethrows). */
async function scoped<T>(p: Promise<T>): Promise<T | string[]> {
  try {
    return await p;
  } catch (e) {
    const missing = missingScopes(e);
    if (!missing.length) throw e;
    return missing;
  }
}
