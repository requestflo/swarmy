import { createHash, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { DB } from '@swarmy/db';

/**
 * swarmy as an OpenID Connect provider.
 *
 * First-party tools running in the cluster (the self-hosted NetBird dashboard
 * and client first) sign people in with their swarmy account, which itself may
 * be SSO or social. So "log in to NetBird" is "log in to swarmy", and the
 * groups swarmy knows about (SSO claims mapped to groups, teams) travel in the
 * token for NetBird to turn into its own groups.
 *
 * Built on Better Auth's `@better-auth/oauth-provider` (the old `oidcProvider`
 * plugin is deprecated and gone in 1.7) plus the `jwt` plugin, which signs id
 * tokens and JWT access tokens with a rotating key published at
 * `<issuer>/jwks`.
 *
 *   issuer    = <BETTER_AUTH_URL>/api/auth
 *   discovery = <issuer>/.well-known/openid-configuration
 *   authorize = <issuer>/oauth2/authorize, token = <issuer>/oauth2/token,
 *   userinfo  = <issuer>/oauth2/userinfo, jwks = <issuer>/jwks
 *
 * Clients are registered only by swarmy itself (see oidc-clients.ts); the
 * HTTP client-CRUD and dynamic registration endpoints are closed.
 */

/** Better Auth model names, renamed so nothing collides with the REST API's `OAuthClient`. */
export const OIDC_MODEL_NAMES = {
  oauthClient: 'oidcClient',
  oauthAccessToken: 'oidcAccessToken',
  oauthRefreshToken: 'oidcRefreshToken',
  oauthConsent: 'oidcConsent',
} as const;

/** Scopes swarmy serves. `groups` is advertised so clients can ask for it by name. */
export const OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'groups'] as const;

/**
 * Paths to switch off on the Better Auth instance when the provider is on: the
 * jwt plugin's `/token` mints a JWT for any session, which the provider would
 * otherwise accept as an access token.
 */
export const OIDC_DISABLED_PATHS = ['/token'] as const;

const AUTH_BASE_PATH = '/api/auth';

/** The public issuer URL (matches Better Auth's `baseURL` + basePath). */
export function oidcIssuer(env: Record<string, string | undefined> = process.env): string {
  const base = (env.BETTER_AUTH_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
  return `${base}${AUTH_BASE_PATH}`;
}

// ── Client secrets ──────────────────────────────────────────────────────────

/** How swarmy stores confidential-client secrets: sha256 hex. Shared by the plugin and oidc-clients.ts. */
export function hashOidcClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verifyOidcClientSecret(secret: string, stored: string): boolean {
  const a = Buffer.from(hashOidcClientSecret(secret), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Claims ──────────────────────────────────────────────────────────────────

/** Email addresses swarmy invents for accounts that have none (username / IdP without email). */
function isRealEmail(email: unknown): email is string {
  return typeof email === 'string' && email.includes('@') && !email.toLowerCase().endsWith('.swarmy.invalid');
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * A principal's groups: Member.attributes.groups ∪ ssoGroups ∪ teamIds (the
 * same union the ABAC principal uses), de-duplicated and sorted so tokens are
 * stable.
 */
export function memberGroups(attributes: unknown): string[] {
  const a = (attributes && typeof attributes === 'object' ? attributes : {}) as Record<string, unknown>;
  return [...new Set([...strings(a.groups), ...strings(a.ssoGroups), ...strings(a.teamIds)])].sort();
}

export interface ClaimsMembership {
  orgId: string;
  orgSlug?: string | null;
  role: string;
  attributes: unknown;
}

export interface ClaimsUser {
  id: string;
  email?: string | null;
  name?: string | null;
  username?: string | null;
  displayUsername?: string | null;
}

/**
 * The swarmy claims added to id tokens, JWT access tokens and userinfo. Pure.
 * A placeholder email is blanked (`undefined` drops the standard claim the
 * provider would otherwise emit), so a relying party never mails a
 * `.swarmy.invalid` address.
 */
export function buildIdentityClaims(user: ClaimsUser, membership: ClaimsMembership | null): Record<string, unknown> {
  const realEmail = isRealEmail(user.email);
  const preferred =
    user.username || user.displayUsername || (realEmail ? user.email!.split('@')[0] : undefined) || undefined;
  return {
    preferred_username: preferred,
    ...(realEmail ? {} : { email: undefined, email_verified: undefined }),
    groups: membership ? memberGroups(membership.attributes) : [],
    ...(membership
      ? { org: membership.orgId, org_slug: membership.orgSlug ?? undefined, role: membership.role }
      : {}),
  };
}

/**
 * The user's membership for claims: their earliest org (what a fresh session
 * activates too). swarmy runs one org per controller in practice.
 */
export async function loadClaimsMembership(db: DB, userId: string): Promise<ClaimsMembership | null> {
  const m = await db.member.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true, role: true, attributes: true, organization: { select: { slug: true } } },
  });
  if (!m) return null;
  return { orgId: m.organizationId, orgSlug: m.organization?.slug ?? null, role: m.role, attributes: m.attributes };
}

async function claimsFor(db: DB, user: (ClaimsUser & Record<string, unknown>) | null | undefined) {
  if (!user?.id) return {};
  return buildIdentityClaims(user, await loadClaimsMembership(db, user.id));
}

// ── The plugins ─────────────────────────────────────────────────────────────

/**
 * The jwt + oauth-provider plugin pair. Add both to the Better Auth `plugins`
 * and `OIDC_DISABLED_PATHS` to `disabledPaths`.
 */
export function swarmyOidcProvider(db: DB, env: Record<string, string | undefined> = process.env): BetterAuthPlugin[] {
  const extraAudiences = (env.SWARMY_OIDC_AUDIENCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    jwt({
      // RS256: the widest relying-party support (NetBird's JWKS validator included).
      jwks: { keyPairConfig: { alg: 'RS256', modulusLength: 2048 } },
      // No `set-auth-jwt` header on every get-session; tokens come only from /oauth2/token.
      disableSettingJwtHeader: true,
    }) as BetterAuthPlugin,
    oauthProvider({
      schema: {
        oauthClient: { modelName: OIDC_MODEL_NAMES.oauthClient },
        oauthAccessToken: { modelName: OIDC_MODEL_NAMES.oauthAccessToken },
        oauthRefreshToken: { modelName: OIDC_MODEL_NAMES.oauthRefreshToken },
        oauthConsent: { modelName: OIDC_MODEL_NAMES.oauthConsent },
      },
      scopes: [...OIDC_SCOPES],
      // The dashboard login page. The provider appends the signed authorize
      // query; the dashboard's auth client (oauthProviderClient) sends it back
      // with the sign-in, and the provider resumes the flow.
      loginPage: '/login',
      // Only swarmy-registered first-party clients exist and all skip consent.
      // A page is still required by the plugin; it is never reached for them.
      consentPage: '/login/consent',
      ...(extraAudiences.length ? { validAudiences: [oidcIssuer(env), ...extraAudiences] } : {}),
      // Clients are registered by swarmy code (oidc-clients.ts), never over HTTP.
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientPrivileges: () => false,
      storeClientSecret: { hash: hashOidcClientSecret, verify: verifyOidcClientSecret },
      customIdTokenClaims: ({ user }) => claimsFor(db, user),
      customAccessTokenClaims: ({ user }) => claimsFor(db, user),
      customUserInfoClaims: ({ user }) => claimsFor(db, user),
      advertisedMetadata: {
        claims_supported: ['preferred_username', 'groups', 'org', 'org_slug', 'role', 'email', 'name', 'picture'],
      },
      // The issuer path is Better Auth's basePath, so discovery is served at
      // <issuer>/.well-known/openid-configuration; apps/api also forwards the
      // RFC 8414 root path.
      silenceWarnings: { openidConfig: true, oauthAuthServerConfig: true },
    }) as unknown as BetterAuthPlugin,
  ];
}
