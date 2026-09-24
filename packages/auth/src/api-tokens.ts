import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { oidcIssuer, SWARMY_API_SCOPES, swarmyApiAudiences } from './oidc-provider';
import type { EnsureOidcClientInput, OidcClientDb, OidcClientInfo } from './oidc-clients';
import { ensureOidcClient } from './oidc-clients';

/**
 * swarmy's OIDC provider as the authorization server for swarmy's OWN APIs:
 * the MCP endpoint (`/mcp`) and the REST API (`/api/v1`) accept a JWT access
 * token that swarmy issued for them, as well as an `swk_…` API key.
 *
 * - Scopes: `swarmy:read` (look) and `swarmy:write` (change; implies read).
 *   A token with neither is an identity token for some other relying party
 *   and is refused here.
 * - Audience: the client asks for the resource by URL (RFC 8707 `resource`,
 *   which MCP clients always send); the provider then issues a JWT whose
 *   `aud` is that URL. Only swarmy's own API URLs are accepted.
 * - The principal is resolved per request (current membership and role), in
 *   `@swarmy/trpc` `apiKeyContext` — the one seam where a bearer becomes a
 *   principal.
 */

export { SWARMY_API_SCOPES, swarmyApiAudiences, type SwarmyApiScope } from './oidc-provider';

export interface VerifiedApiToken {
  /** The user id (`sub`). */
  userId: string;
  scopes: string[];
  /** The org the token was issued in (`org` claim), when present. */
  orgId: string | null;
  clientId: string | null;
}

/** Minimal slice of a Better Auth instance: its request handler. */
export interface AuthHandler {
  handler: (req: Request) => Promise<Response>;
}

/**
 * Build a verifier for swarmy-issued API access tokens. The signing keys are
 * read in-process from the provider's JWKS endpoint (never over the network:
 * a controller behind NAT may not reach its own public URL), cached by the
 * better-auth verifier under `cacheKey`.
 */
export function createApiTokenVerifier(
  getAuth: () => AuthHandler,
  env: Record<string, string | undefined> = process.env,
): (token: string) => Promise<VerifiedApiToken | null> {
  const issuer = oidcIssuer(env);
  const audience = swarmyApiAudiences(env);
  const cacheKey = {};
  const jwksFetch = async () => {
    const res = await getAuth().handler(new Request(`${issuer}/jwks`));
    return res.ok ? ((await res.json()) as { keys: never[] }) : undefined;
  };
  return async (token) => {
    if (token.split('.').length !== 3) return null;
    try {
      const payload = await verifyJwsAccessToken(token, {
        jwksFetch,
        jwksCacheKey: cacheKey,
        verifyOptions: { issuer, audience },
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : null;
      if (!sub) return null;
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      return {
        userId: sub,
        scopes: scope.split(' ').filter(Boolean),
        orgId: typeof payload.org === 'string' ? payload.org : null,
        clientId:
          typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : null,
      };
    } catch {
      return null;
    }
  };
}

// ── The MCP client ──────────────────────────────────────────────────────────

/** Pre-registered public client for MCP hosts (Claude Code, Cursor, …): PKCE, no secret. */
export const MCP_OIDC_CLIENT_ID = 'swarmy-mcp';

/**
 * Fixed loopback callback MCP hosts can be told to use (e.g. Claude Code's
 * `--callback-port`). `127.0.0.1` redirects also match on any port (RFC 8252
 * §7.3), for hosts that pick their own.
 */
export const MCP_CALLBACK_PORT = 33418;

export function MCP_OIDC_CLIENT(): EnsureOidcClientInput {
  return {
    clientId: MCP_OIDC_CLIENT_ID,
    name: 'MCP clients (Claude Code, Cursor, …)',
    type: 'public',
    skipConsent: true,
    redirectUris: [
      `http://localhost:${MCP_CALLBACK_PORT}/callback`,
      `http://127.0.0.1:${MCP_CALLBACK_PORT}/callback`,
      'http://127.0.0.1/callback',
    ],
    scopes: ['openid', 'profile', 'email', 'offline_access', ...SWARMY_API_SCOPES],
  };
}

/** Register (or refresh) the MCP client. Idempotent; call on boot. */
export function ensureMcpOidcClient(db: OidcClientDb): Promise<OidcClientInfo> {
  return ensureOidcClient(db, MCP_OIDC_CLIENT());
}
