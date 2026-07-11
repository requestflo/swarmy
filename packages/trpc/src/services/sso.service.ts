import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Per-org enterprise SSO providers (OIDC via Better Auth's genericOAuth; SAML
 * stored but not yet wired — see INTEGRATION). Secrets (OIDC client secret / SAML
 * SP private key) are write-only and encrypted via the shared vault. The admin
 * UI gets the IdP-facing URLs (login start, callback) to paste into the IdP.
 */

const PUBLIC_BASE =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

function base(): string {
  return PUBLIC_BASE.replace(/\/$/, '');
}

/** The genericOAuth callback URL the IdP must allow-list (OIDC redirect URI). */
export function ssoCallbackUrl(providerId: string): string {
  return `${base()}/api/auth/oauth2/callback/${providerId}`;
}

/** The login-start URL the dashboard hits to begin an SSO flow. */
export function ssoLoginUrl(providerId: string): string {
  return `${base()}/api/auth/sign-in/oauth2/${providerId}`;
}

export interface SsoProviderView {
  id: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
  domain: string | null;
  issuer: string | null;
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  mapping: Record<string, string>;
  callbackUrl: string;
  loginUrl: string;
}

function toView(row: {
  id: string;
  providerId: string;
  protocol: string;
  domain: string | null;
  issuer: string | null;
  clientId: string | null;
  encryptedSecret: string | null;
  enabled: boolean;
  metadata: unknown;
  mapping: unknown;
}): SsoProviderView {
  return {
    id: row.id,
    providerId: row.providerId,
    protocol: (row.protocol === 'saml' ? 'saml' : 'oidc') as 'oidc' | 'saml',
    domain: row.domain,
    issuer: row.issuer,
    clientId: row.clientId,
    hasSecret: Boolean(row.encryptedSecret),
    enabled: row.enabled,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    mapping: (row.mapping as Record<string, string>) ?? {},
    callbackUrl: ssoCallbackUrl(row.providerId),
    loginUrl: ssoLoginUrl(row.providerId),
  };
}

export async function listSsoProviders(ctx: OrgContext): Promise<SsoProviderView[]> {
  const rows = await ctx.db.ssoProvider.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

export interface UpsertSsoArgs {
  id?: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
  domain?: string | null;
  issuer?: string | null;
  clientId?: string | null;
  /** Write-only secret; omit to keep the stored one. */
  clientSecret?: string;
  enabled?: boolean;
  /** OIDC discovery / endpoints / SAML IdP metadata. */
  metadata?: Record<string, unknown>;
  /** claim → user/member attribute mapping. */
  mapping?: Record<string, string>;
}

export async function upsertSsoProvider(ctx: OrgContext, args: UpsertSsoArgs): Promise<SsoProviderView> {
  if (!/^[a-z0-9-]{2,40}$/.test(args.providerId)) {
    throw new Error('providerId must be a slug (a-z, 0-9, dash; 2–40 chars)');
  }
  const encryptedSecret = args.clientSecret ? encryptSecret(args.clientSecret) : undefined;

  if (args.id) {
    const existing = await ctx.db.ssoProvider.findFirst({
      where: { id: args.id, orgId: ctx.activeOrgId },
      select: { id: true },
    });
    if (!existing) throw notFound('sso provider', args.id);
    const row = await ctx.db.ssoProvider.update({
      where: { id: args.id },
      data: {
        providerId: args.providerId,
        protocol: args.protocol,
        domain: args.domain ?? null,
        issuer: args.issuer ?? null,
        clientId: args.clientId ?? null,
        ...(encryptedSecret ? { encryptedSecret } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.metadata ? { metadata: args.metadata as object } : {}),
        ...(args.mapping ? { mapping: args.mapping as object } : {}),
      },
    });
    await writeAudit(ctx, {
      action: 'sso.update',
      targetType: 'sso_provider',
      targetId: row.id,
      metadata: { providerId: row.providerId, protocol: row.protocol },
    });
    return toView(row);
  }

  const row = await ctx.db.ssoProvider.create({
    data: {
      orgId: ctx.activeOrgId,
      providerId: args.providerId,
      protocol: args.protocol,
      domain: args.domain ?? null,
      issuer: args.issuer ?? null,
      clientId: args.clientId ?? null,
      ...(encryptedSecret ? { encryptedSecret } : {}),
      enabled: args.enabled ?? true,
      metadata: (args.metadata ?? {}) as object,
      mapping: (args.mapping ?? {}) as object,
    },
  });
  await writeAudit(ctx, {
    action: 'sso.create',
    targetType: 'sso_provider',
    targetId: row.id,
    metadata: { providerId: row.providerId, protocol: row.protocol },
  });
  return toView(row);
}

export async function deleteSsoProvider(ctx: OrgContext, id: string): Promise<{ id: string; deleted: true }> {
  const row = await ctx.db.ssoProvider.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!row) throw notFound('sso provider', id);
  await ctx.db.ssoProvider.delete({ where: { id } });
  await writeAudit(ctx, { action: 'sso.delete', targetType: 'sso_provider', targetId: id });
  return { id, deleted: true };
}
