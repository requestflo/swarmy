import type { DB } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';

/**
 * Social providers we support toggling on from the dashboard. Instance-wide
 * (the self-host norm: one OAuth app for the whole controller). Each is enabled
 * by storing an `AuthProviderConfig` row with `enabled`, a `clientId`, and an
 * encrypted client secret.
 */
export const SOCIAL_PROVIDERS = ['github', 'google'] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

export function isSocialProvider(type: string): type is SocialProviderId {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(type);
}

/**
 * Non-social auth methods toggled the same way (no OAuth secret). `passkey` and
 * `magic_link` are instance-wide and stored as `AuthProviderConfig` rows whose
 * only meaningful field is `enabled`.
 */
export const AUTH_METHODS = ['passkey', 'magic_link'] as const;
export type AuthMethodId = (typeof AUTH_METHODS)[number];

export function isAuthMethod(type: string): type is AuthMethodId {
  return (AUTH_METHODS as readonly string[]).includes(type);
}

/** Decrypted, ready-to-construct social provider credentials. */
export interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/** A resolved per-org enterprise SSO provider (OIDC via genericOAuth, or SAML). */
export interface ResolvedSsoProvider {
  providerId: string;
  protocol: 'oidc' | 'saml';
  orgId: string;
  domain?: string | null;
  issuer?: string | null;
  discoveryUrl?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userInfoUrl?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string[];
  /** claim → user/member-attribute mapping (e.g. { email: "mail", name: "displayName" }). */
  mapping?: Record<string, string>;
}

/**
 * Fully-resolved auth configuration handed to {@link buildAuth}. Secrets here are
 * already decrypted — this object lives only in-process and is never serialized
 * to the client.
 */
export interface ResolvedAuthConfig {
  social: Partial<Record<SocialProviderId, ResolvedSocialProvider>>;
  /** Instance-wide method toggles. */
  passkey?: boolean;
  magicLink?: boolean;
  /** Per-org enterprise SSO providers (OIDC handled via genericOAuth). */
  sso?: ResolvedSsoProvider[];
}

/** A provider's public status for the admin UI — never includes the secret. */
export interface ProviderStatus {
  type: SocialProviderId;
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string[];
}

interface EnvFallback {
  clientIdVar: string;
  clientSecretVar: string;
}

const ENV_FALLBACK: Record<SocialProviderId, EnvFallback> = {
  github: { clientIdVar: 'GITHUB_CLIENT_ID', clientSecretVar: 'GITHUB_CLIENT_SECRET' },
  google: { clientIdVar: 'GOOGLE_CLIENT_ID', clientSecretVar: 'GOOGLE_CLIENT_SECRET' },
};

function safeDecrypt(blob: string | null | undefined): string | undefined {
  if (!blob) return undefined;
  try {
    return decryptSecret(blob);
  } catch {
    return undefined;
  }
}

/**
 * Read stored provider config (instance-wide rows, `orgId = null`), decrypt
 * secrets, and merge with env fallbacks so a power user can still seed a provider
 * via env on first boot. The DB is the source of truth; env is only a fallback
 * for rows that have no stored secret. Also loads instance-wide method toggles
 * (passkey/magic-link) and per-org enterprise SSO providers.
 */
export async function loadAuthConfig(db: DB): Promise<ResolvedAuthConfig> {
  const rows = await db.authProviderConfig.findMany({ where: { orgId: null } });
  const social: ResolvedAuthConfig['social'] = {};
  let passkey = false;
  let magicLink = false;

  for (const row of rows) {
    if (isAuthMethod(row.type)) {
      if (row.type === 'passkey') passkey = row.enabled;
      if (row.type === 'magic_link') magicLink = row.enabled;
      continue;
    }
    if (!row.enabled || !isSocialProvider(row.type)) continue;
    const type: SocialProviderId = row.type;
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];

    let clientId = row.clientId ?? undefined;
    let clientSecret = safeDecrypt(row.encryptedSecret);

    const fallback = ENV_FALLBACK[type];
    clientId ??= process.env[fallback.clientIdVar];
    clientSecret ??= process.env[fallback.clientSecretVar];

    if (clientId && clientSecret) {
      social[type] = { clientId, clientSecret, scopes: scopes.length ? scopes : undefined };
    }
  }

  // Env-only seed for providers with no row at all (first boot convenience).
  for (const type of SOCIAL_PROVIDERS) {
    if (social[type]) continue;
    const fallback = ENV_FALLBACK[type];
    const clientId = process.env[fallback.clientIdVar];
    const clientSecret = process.env[fallback.clientSecretVar];
    if (clientId && clientSecret) social[type] = { clientId, clientSecret };
  }

  const sso = await loadSsoProviders(db);

  return { social, passkey, magicLink, sso };
}

/** Load and decrypt enabled per-org SSO providers from `SsoProvider` rows. */
export async function loadSsoProviders(db: DB): Promise<ResolvedSsoProvider[]> {
  const rows = await db.ssoProvider.findMany({ where: { enabled: true } });
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const mapping = (row.mapping ?? {}) as Record<string, string>;
    return {
      providerId: row.providerId,
      protocol: (row.protocol === 'saml' ? 'saml' : 'oidc') as 'oidc' | 'saml',
      orgId: row.orgId,
      domain: row.domain,
      issuer: row.issuer,
      discoveryUrl: typeof meta.discoveryUrl === 'string' ? meta.discoveryUrl : null,
      authorizationUrl: typeof meta.authorizationUrl === 'string' ? meta.authorizationUrl : null,
      tokenUrl: typeof meta.tokenUrl === 'string' ? meta.tokenUrl : null,
      userInfoUrl: typeof meta.userInfoUrl === 'string' ? meta.userInfoUrl : null,
      clientId: row.clientId,
      clientSecret: safeDecrypt(row.encryptedSecret) ?? null,
      scopes: Array.isArray(meta.scopes) ? (meta.scopes as string[]) : ['openid', 'email', 'profile'],
      mapping,
    };
  });
}

/**
 * Resolve which SSO provider an email address routes to, by its domain. Used by
 * the sign-in page ("Sign in with your company") and JIT provisioning. Returns
 * the matching enabled provider or `null`.
 */
export function resolveSsoProviderByEmail(
  email: string,
  providers: ResolvedSsoProvider[],
): ResolvedSsoProvider | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return providers.find((p) => (p.domain ?? '').toLowerCase() === domain) ?? null;
}
