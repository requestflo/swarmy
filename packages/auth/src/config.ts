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

/** Decrypted, ready-to-construct social provider credentials. */
export interface ResolvedSocialProvider {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

/**
 * Fully-resolved auth configuration handed to {@link buildAuth}. Secrets here are
 * already decrypted — this object lives only in-process and is never serialized
 * to the client.
 */
export interface ResolvedAuthConfig {
  social: Partial<Record<SocialProviderId, ResolvedSocialProvider>>;
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

/**
 * Read stored provider config (instance-wide rows, `orgId = null`), decrypt
 * secrets, and merge with env fallbacks so a power user can still seed a provider
 * via env on first boot. The DB is the source of truth; env is only a fallback
 * for rows that have no stored secret.
 */
export async function loadAuthConfig(db: DB): Promise<ResolvedAuthConfig> {
  const rows = await db.authProviderConfig.findMany({ where: { orgId: null } });
  const social: ResolvedAuthConfig['social'] = {};

  for (const row of rows) {
    if (!row.enabled || !isSocialProvider(row.type)) continue;
    const type: SocialProviderId = row.type;
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];

    let clientId = row.clientId ?? undefined;
    let clientSecret: string | undefined;
    if (row.encryptedSecret) {
      try {
        clientSecret = decryptSecret(row.encryptedSecret);
      } catch {
        clientSecret = undefined;
      }
    }

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

  return { social };
}
