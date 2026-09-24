import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@swarmy/db';
import { hashOidcClientSecret, oidcIssuer, OIDC_SCOPES } from './oidc-provider';

/**
 * Registering first-party OIDC clients with swarmy's identity provider — the
 * interface the mesh work calls to let the in-cluster NetBird sign people in
 * with their swarmy account. Clients are written straight to the provider's
 * table; there is no HTTP registration.
 *
 * A confidential client's secret is returned exactly once (on create or
 * rotate) and stored only as a sha256 hash.
 */

export type OidcClientType = 'public' | 'confidential';

export interface EnsureOidcClientInput {
  clientId: string;
  name: string;
  redirectUris: string[];
  /** `public` = PKCE, no secret (SPAs, CLIs). `confidential` = has a secret. */
  type: OidcClientType;
  /** First-party clients skip the consent screen (swarmy has none). Default true. */
  skipConsent?: boolean;
  postLogoutRedirectUris?: string[];
}

export interface OidcClientInfo {
  issuer: string;
  clientId: string;
  /** Plaintext secret — only on create/rotate of a confidential client. */
  clientSecret?: string;
  discoveryUrl: string;
  jwksUrl: string;
  /** The `aud` of id tokens (the client id). */
  audience: string;
  created: boolean;
}

/** The slice of Prisma these helpers use (keeps them unit-testable). */
export type OidcClientDb = Pick<DB, 'oidcClient'>;

const CLIENT_ID_RE = /^[a-zA-Z0-9._-]{3,64}$/;

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function oidcEndpoints(env: Record<string, string | undefined> = process.env) {
  const issuer = oidcIssuer(env);
  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    jwksUrl: `${issuer}/jwks`,
    authorizeUrl: `${issuer}/oauth2/authorize`,
    tokenUrl: `${issuer}/oauth2/token`,
    userinfoUrl: `${issuer}/oauth2/userinfo`,
  };
}

function info(clientId: string, created: boolean, clientSecret?: string): OidcClientInfo {
  const { issuer, discoveryUrl, jwksUrl } = oidcEndpoints();
  return { issuer, clientId, discoveryUrl, jwksUrl, audience: clientId, created, ...(clientSecret ? { clientSecret } : {}) };
}

/** The row shape for a client (without id / secret / timestamps). Pure. */
export function oidcClientRow(input: EnsureOidcClientInput) {
  const isPublic = input.type === 'public';
  return {
    name: input.name,
    redirectUris: [...input.redirectUris],
    postLogoutRedirectUris: [...(input.postLogoutRedirectUris ?? [])],
    public: isPublic,
    type: isPublic ? 'user-agent-based' : 'web',
    tokenEndpointAuthMethod: isPublic ? 'none' : 'client_secret_basic',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    requirePKCE: isPublic ? true : null,
    scopes: [...OIDC_SCOPES],
    skipConsent: input.skipConsent ?? true,
    disabled: false,
  };
}

function validate(input: EnsureOidcClientInput): void {
  if (!CLIENT_ID_RE.test(input.clientId)) throw new Error(`invalid OIDC client id "${input.clientId}"`);
  if (!input.redirectUris.length) throw new Error('an OIDC client needs at least one redirect URI');
  for (const uri of input.redirectUris) {
    const u = new URL(uri); // throws on garbage
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`redirect URI must be http(s): ${uri}`);
  }
}

/**
 * Create the client if missing, otherwise bring its name / redirect URIs /
 * type / consent in line (the secret is kept). Idempotent.
 */
export async function ensureOidcClient(db: OidcClientDb, input: EnsureOidcClientInput): Promise<OidcClientInfo> {
  validate(input);
  const row = oidcClientRow(input);
  const now = new Date();
  const existing = await db.oidcClient.findUnique({
    where: { clientId: input.clientId },
    select: { id: true, clientSecret: true },
  });
  if (existing) {
    // Switching public → confidential needs a secret; hand one out once.
    const secret = !row.public && !existing.clientSecret ? newSecret() : undefined;
    await db.oidcClient.update({
      where: { clientId: input.clientId },
      data: {
        ...row,
        clientSecret: row.public ? null : secret ? hashOidcClientSecret(secret) : existing.clientSecret,
        updatedAt: now,
      },
    });
    return info(input.clientId, false, secret);
  }
  const secret = row.public ? undefined : newSecret();
  await db.oidcClient.create({
    data: {
      id: randomUUID(),
      clientId: input.clientId,
      clientSecret: secret ? hashOidcClientSecret(secret) : null,
      ...row,
      createdAt: now,
      updatedAt: now,
    },
  });
  return info(input.clientId, true, secret);
}

/** New secret for a confidential client; the old one stops working at once. */
export async function rotateOidcClientSecret(db: OidcClientDb, clientId: string): Promise<OidcClientInfo> {
  const existing = await db.oidcClient.findUnique({ where: { clientId }, select: { public: true } });
  if (!existing) throw new Error(`OIDC client "${clientId}" not found`);
  if (existing.public) throw new Error(`OIDC client "${clientId}" is public and has no secret`);
  const secret = newSecret();
  await db.oidcClient.update({
    where: { clientId },
    data: { clientSecret: hashOidcClientSecret(secret), updatedAt: new Date() },
  });
  return info(clientId, false, secret);
}

/** Remove a client; its tokens and consents go with it (FK cascade). */
export async function removeOidcClient(db: OidcClientDb, clientId: string): Promise<{ removed: boolean }> {
  const { count } = await db.oidcClient.deleteMany({ where: { clientId } });
  return { removed: count > 0 };
}

// ── NetBird ─────────────────────────────────────────────────────────────────

/** The client id the self-hosted NetBird (dashboard + client) uses. */
export const NETBIRD_OIDC_CLIENT_ID = 'swarmy-netbird';

/** Loopback redirects the NetBird CLI's PKCE flow listens on. */
export const NETBIRD_CLI_REDIRECTS = ['http://localhost:53000', 'http://localhost:54000'] as const;

/**
 * The NetBird preset: one public PKCE client shared by the NetBird dashboard
 * (`/nb-auth`, `/nb-silent-auth`) and the NetBird client's CLI login. Pure.
 */
export function NETBIRD_OIDC_CLIENT(dashboardUrl: string): EnsureOidcClientInput {
  const base = dashboardUrl.replace(/\/+$/, '');
  return {
    clientId: NETBIRD_OIDC_CLIENT_ID,
    name: 'NetBird',
    type: 'public',
    skipConsent: true,
    redirectUris: [`${base}/nb-auth`, `${base}/nb-silent-auth`, ...NETBIRD_CLI_REDIRECTS],
    postLogoutRedirectUris: [base],
  };
}

/** Register (or refresh) the NetBird client for the dashboard at `dashboardUrl`. */
export function ensureNetbirdOidcClient(db: OidcClientDb, opts: { dashboardUrl: string }): Promise<OidcClientInfo> {
  return ensureOidcClient(db, NETBIRD_OIDC_CLIENT(opts.dashboardUrl));
}
