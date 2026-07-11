import { encryptSecret } from '@swarmy/core/crypto';
import {
  SOCIAL_PROVIDERS,
  AUTH_METHODS,
  isSocialProvider,
  isAuthMethod,
  type ProviderStatus,
} from '@swarmy/auth';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Provider config is instance-wide (`orgId = null`). We still org-scope the API
 * (admin-gated within the active org) and audit every change. Secrets are
 * write-only: stored encrypted via the shared vault, never returned to the client
 * — the UI shows `hasSecret` and a "rotate" affordance.
 *
 * Two row classes share the `auth_provider_config` table:
 *  - social providers (github/google): clientId + encrypted secret + scopes;
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
      enabled: row?.enabled ?? false,
      clientId: row?.clientId ?? null,
      hasSecret: Boolean(row?.encryptedSecret),
      scopes,
      callbackUrl: callbackUrl(type),
    };
  });

  const methods: ProviderListEntry[] = AUTH_METHODS.map((type) => {
    const row = byType.get(type);
    return {
      type,
      kind: 'method' as const,
      enabled: row?.enabled ?? false,
      clientId: null,
      hasSecret: false,
      scopes: [],
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

  await ctx.db.authProviderConfig.upsert({
    where: { orgId_type: { orgId: null as unknown as string, type: args.type } },
    create: {
      orgId: null,
      type: args.type,
      enabled: args.enabled ?? false,
      clientId: social ? (args.clientId ?? null) : null,
      ...(encryptedSecret ? { encryptedSecret } : {}),
      scopes: social ? (args.scopes ?? []) : [],
    },
    update: {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(social && args.clientId !== undefined ? { clientId: args.clientId } : {}),
      ...(encryptedSecret ? { encryptedSecret } : {}),
      ...(social && args.scopes !== undefined ? { scopes: args.scopes } : {}),
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
    },
  });

  const all = await listProviders(ctx);
  return all.find((p) => p.type === args.type)!;
}
