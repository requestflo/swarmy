import { encryptSecret } from '@swarmy/core/crypto';
import { SOCIAL_PROVIDERS, isSocialProvider, type ProviderStatus } from '@swarmy/auth';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Provider config is instance-wide (`orgId = null`). We still org-scope the API
 * (admin-gated within the active org) and audit every change. Secrets are
 * write-only: stored encrypted via the shared vault, never returned to the client
 * — the UI shows `hasSecret` and a "rotate" affordance.
 */

const CALLBACK_BASE =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3001';

/** The exact callback/redirect URL to paste into the provider's OAuth app. */
export function callbackUrl(type: string): string {
  return `${CALLBACK_BASE.replace(/\/$/, '')}/api/auth/callback/${type}`;
}

export interface ProviderListEntry extends ProviderStatus {
  callbackUrl: string;
}

export async function listProviders(ctx: OrgContext): Promise<ProviderListEntry[]> {
  const rows = await ctx.db.authProviderConfig.findMany({ where: { orgId: null } });
  const byType = new Map(rows.map((r) => [r.type, r]));
  return SOCIAL_PROVIDERS.map((type) => {
    const row = byType.get(type);
    const scopes = row && Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return {
      type,
      enabled: row?.enabled ?? false,
      clientId: row?.clientId ?? null,
      hasSecret: Boolean(row?.encryptedSecret),
      scopes,
      callbackUrl: callbackUrl(type),
    };
  });
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
  if (!isSocialProvider(args.type)) {
    throw new Error(`unsupported provider "${args.type}"`);
  }
  const encryptedSecret = args.clientSecret ? encryptSecret(args.clientSecret) : undefined;

  await ctx.db.authProviderConfig.upsert({
    where: { orgId_type: { orgId: null as unknown as string, type: args.type } },
    create: {
      orgId: null,
      type: args.type,
      enabled: args.enabled ?? false,
      clientId: args.clientId ?? null,
      ...(encryptedSecret ? { encryptedSecret } : {}),
      scopes: args.scopes ?? [],
    },
    update: {
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.clientId !== undefined ? { clientId: args.clientId } : {}),
      ...(encryptedSecret ? { encryptedSecret } : {}),
      ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
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
