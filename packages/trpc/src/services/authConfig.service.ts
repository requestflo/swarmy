import { encryptSecret } from '@swarmy/core/crypto';
import {
  SOCIAL_PROVIDERS,
  SOCIAL_PROVIDER_LABELS,
  AUTH_METHODS,
  cleanSocialSettings,
  isSocialProvider,
  isAuthMethod,
  type ProviderStatus,
} from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Provider config is instance-wide (`orgId = null`). We still org-scope the API
 * (admin-gated within the active org) and audit every change. Secrets are
 * write-only: stored encrypted via the shared vault, never returned to the client
 * — the UI shows `hasSecret` and a "rotate" affordance.
 *
 * Two row classes share the `auth_provider_config` table:
 *  - social providers (microsoft/google/github/gitlab): clientId + encrypted
 *    secret + scopes + non-secret `settings` (Entra tenant, GitLab issuer);
 *  - auth methods (passkey/magic_link): just an `enabled` toggle, no secret.
 */

const CALLBACK_BASE =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

/** The exact callback/redirect URL to paste into the provider's OAuth app. */
export function callbackUrl(type: string): string {
  return `${CALLBACK_BASE.replace(/\/$/, '')}/api/auth/callback/${type}`;
}

export type ProviderKind = 'social' | 'method';

export interface ProviderListEntry extends Omit<ProviderStatus, 'type'> {
  type: string;
  kind: ProviderKind;
  label: string;
  callbackUrl: string;
}

export async function listProviders(ctx: OrgContext): Promise<ProviderListEntry[]> {
  const rows = await ctx.db.authProviderConfig.findMany({ where: { orgId: null } });
  const byType = new Map(rows.map((r) => [r.type, r]));

  const social: ProviderListEntry[] = SOCIAL_PROVIDERS.map((type) => {
    const row = byType.get(type);
    const scopes = row && Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return {
      type,
      kind: 'social' as const,
      label: SOCIAL_PROVIDER_LABELS[type],
      enabled: row?.enabled ?? false,
      clientId: row?.clientId ?? null,
      hasSecret: Boolean(row?.encryptedSecret),
      scopes,
      settings: cleanSocialSettings(type, row?.settings),
      callbackUrl: callbackUrl(type),
    };
  });

  const methods: ProviderListEntry[] = AUTH_METHODS.map((type) => {
    const row = byType.get(type);
    return {
      type,
      kind: 'method' as const,
      label: type === 'magic_link' ? 'Magic link' : 'Passkeys',
      enabled: row?.enabled ?? false,
      clientId: null,
      hasSecret: false,
      scopes: [],
      settings: {},
      callbackUrl: '',
    };
  });

  return [...social, ...methods];
}

export interface SetProviderArgs {
  type: string;
  enabled?: boolean;
  clientId?: string;
  /** Plaintext secret to store (write-only). Omit to leave the stored secret. */
  clientSecret?: string;
  scopes?: string[];
  /** Non-secret provider settings (Entra `tenantId`, GitLab `issuer`). */
  settings?: Record<string, string>;
}

export async function setProvider(
  ctx: OrgContext,
  args: SetProviderArgs,
): Promise<ProviderListEntry> {
  const social = isSocialProvider(args.type);
  const method = isAuthMethod(args.type);
  if (!social && !method) {
    throw new Error(`unsupported provider "${args.type}"`);
  }
  const encryptedSecret = social && args.clientSecret ? encryptSecret(args.clientSecret) : undefined;
  const settings =
    isSocialProvider(args.type) && args.settings !== undefined ? cleanSocialSettings(args.type, args.settings) : undefined;
  if (settings?.issuer && !/^https?:\/\//.test(settings.issuer)) {
    throw new Error('GitLab URL must start with https:// (or http:// on a private network)');
  }

  await ctx.db.authProviderConfig.upsert({
    where: { orgId_type: { orgId: null as unknown as string, type: args.type } },
    create: {
      orgId: null,
      type: args.type,
      enabled: args.enabled ?? false,
      clientId: social ? (args.clientId ?? null) : null,
      ...(encryptedSecret ? { encryptedSecret } : {}),
      scopes: social ? (args.scopes ?? []) : [],
      settings: settings ?? {},
    },
    update: {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(social && args.clientId !== undefined ? { clientId: args.clientId } : {}),
      ...(encryptedSecret ? { encryptedSecret } : {}),
      ...(social && args.scopes !== undefined ? { scopes: args.scopes } : {}),
      ...(settings !== undefined ? { settings } : {}),
    },
  });

  await writeAudit(ctx, {
    action: 'authconfig.setProvider',
    targetType: 'auth_provider',
    targetId: args.type,
    metadata: {
      enabled: args.enabled,
      clientIdChanged: args.clientId !== undefined,
      secretRotated: Boolean(encryptedSecret),
      settingsChanged: settings !== undefined,
    },
  });

  const all = await listProviders(ctx);
  return all.find((p) => p.type === args.type)!;
}

/** A button on the login page. Never carries secrets or org data. */
export interface SignInOption {
  kind: 'social' | 'sso';
  /** social: the provider type; sso: the genericOAuth providerId. */
  id: string;
  label: string;
}

/**
 * The sign-in methods the login page offers, from what is configured and
 * enabled: social providers with credentials (stored or env), and every enabled
 * org OIDC provider. Username + password is always available.
 */
export async function signInOptions(db: DB): Promise<SignInOption[]> {
  const [rows, sso] = await Promise.all([
    db.authProviderConfig.findMany({ where: { orgId: null } }),
    db.ssoProvider.findMany({ where: { enabled: true, protocol: 'oidc' }, orderBy: { createdAt: 'asc' } }),
  ]);
  const byType = new Map(rows.map((r) => [r.type, r]));
  const out: SignInOption[] = [];
  for (const p of sso) {
    if (!p.clientId || !p.encryptedSecret) continue;
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const label = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : p.providerId;
    out.push({ kind: 'sso', id: p.providerId, label });
  }
  for (const type of SOCIAL_PROVIDERS) {
    const row = byType.get(type);
    const envReady = Boolean(process.env[`${type.toUpperCase()}_CLIENT_ID`] && process.env[`${type.toUpperCase()}_CLIENT_SECRET`]);
    const stored = Boolean(row?.enabled && (row.clientId || envReady) && (row.encryptedSecret || envReady));
    // An env-seeded provider with no row is live (loadAuthConfig seeds it).
    if (stored || (!row && envReady)) out.push({ kind: 'social', id: type, label: SOCIAL_PROVIDER_LABELS[type] });
  }
  return out;
}
