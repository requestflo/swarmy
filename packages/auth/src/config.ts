import type { DB } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';

/**
 * Social providers we support toggling on from the dashboard. Instance-wide
 * (the self-host norm: one OAuth app for the whole controller). Each is enabled
 * by storing an `AuthProviderConfig` row with `enabled`, a `clientId`, and an
 * encrypted client secret.
 */
export const SOCIAL_PROVIDERS = ['microsoft', 'google', 'github', 'gitlab'] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

/** Human names for the login buttons and the admin cards. */
export const SOCIAL_PROVIDER_LABELS: Record<SocialProviderId, string> = {
  microsoft: 'Microsoft',
  google: 'Google',
  github: 'GitHub',
  gitlab: 'GitLab',
};

/**
 * Per-provider, non-secret settings (`AuthProviderConfig.settings`):
 *  - microsoft `tenantId`: an Entra ID tenant (GUID or domain) to accept only
 *    your directory; default `common` (any work or personal account).
 *  - gitlab `issuer`: a self-hosted GitLab's base URL; default gitlab.com.
 */
export const SOCIAL_PROVIDER_SETTINGS: Record<SocialProviderId, readonly string[]> = {
  microsoft: ['tenantId'],
  google: [],
  github: [],
  gitlab: ['issuer'],
};

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
  /** Non-secret provider settings (see {@link SOCIAL_PROVIDER_SETTINGS}). */
  settings?: Record<string, string>;
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
  /**
   * claim → user-field mapping (e.g. { email: "mail", name: "displayName" }).
   * The reserved key `groups` names the group claim (default `groups`); see
   * {@link ResolvedSsoProvider.groupMap}.
   */
  mapping?: Record<string, string>;
  /** Button label on the login page (`metadata.displayName`), default the providerId. */
  displayName?: string;
  /** Admit new people on first login and add them to `orgId` (default on). */
  autoProvision?: boolean;
  /** Role for an auto-provisioned member (never owner). */
  defaultRole?: 'admin' | 'member';
  /** IdP group → swarmy group(s) allow-list; empty = pass IdP group names through. */
  groupMap?: Record<string, string>;
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
  settings: Record<string, string>;
}

interface EnvFallback {
  clientIdVar: string;
  clientSecretVar: string;
}

const ENV_FALLBACK: Record<SocialProviderId, EnvFallback> = {
  github: { clientIdVar: 'GITHUB_CLIENT_ID', clientSecretVar: 'GITHUB_CLIENT_SECRET' },
  google: { clientIdVar: 'GOOGLE_CLIENT_ID', clientSecretVar: 'GOOGLE_CLIENT_SECRET' },
  microsoft: { clientIdVar: 'MICROSOFT_CLIENT_ID', clientSecretVar: 'MICROSOFT_CLIENT_SECRET' },
  gitlab: { clientIdVar: 'GITLAB_CLIENT_ID', clientSecretVar: 'GITLAB_CLIENT_SECRET' },
};

/** Env-only settings fallback (first-boot seeding), e.g. MICROSOFT_TENANT_ID. */
function envSettings(type: SocialProviderId): Record<string, string> {
  const out: Record<string, string> = {};
  if (type === 'microsoft' && process.env.MICROSOFT_TENANT_ID) out.tenantId = process.env.MICROSOFT_TENANT_ID;
  if (type === 'gitlab' && process.env.GITLAB_ISSUER) out.issuer = process.env.GITLAB_ISSUER;
  return out;
}

/** Keep only the known, non-empty string settings for a provider. */
export function cleanSocialSettings(type: SocialProviderId, raw: unknown): Record<string, string> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const key of SOCIAL_PROVIDER_SETTINGS[type]) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

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
      const settings = { ...envSettings(type), ...cleanSocialSettings(type, row.settings) };
      social[type] = { clientId, clientSecret, scopes: scopes.length ? scopes : undefined, settings };
    }
  }

  // Env-only seed for providers with no row at all (first boot convenience).
  for (const type of SOCIAL_PROVIDERS) {
    if (social[type]) continue;
    const fallback = ENV_FALLBACK[type];
    const clientId = process.env[fallback.clientIdVar];
    const clientSecret = process.env[fallback.clientSecretVar];
    if (clientId && clientSecret) social[type] = { clientId, clientSecret, settings: envSettings(type) };
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
      displayName: typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : row.providerId,
      autoProvision: meta.autoProvision !== false,
      defaultRole: meta.defaultRole === 'admin' ? 'admin' : 'member',
      groupMap: stringRecord(meta.groupMap),
    };
  });
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
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
