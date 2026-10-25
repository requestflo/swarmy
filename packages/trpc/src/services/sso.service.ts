import { encryptSecret } from '@swarmy/core/crypto';
import { SOCIAL_PROVIDERS } from '@swarmy/auth';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { assertProviderIdClaimable, retireProviderId } from './sso-identities';
import { normalizeSamlInput, samlSetupView, type SamlSetupView } from './sso-saml';
import { assertSsoOnlyKeepsProvider } from './sso-only.service';

/**
 * Per-org enterprise SSO providers (OIDC via Better Auth's genericOAuth, SAML
 * via @better-auth/sso — sso-saml.ts). The OIDC client secret is write-only
 * and encrypted via the shared vault. The admin UI gets the IdP-facing URLs
 * (OIDC callback; SAML SP metadata + ACS) to paste into the IdP.
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
  /** SAML only: the SP URLs for the IdP and whether sign-in is live. */
  saml: SamlSetupView | null;
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
    saml: row.protocol === 'saml' ? samlSetupView(row) : null,
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
  /** OIDC discovery / endpoints; SAML `entryPoint` + `cert` (or `idpMetadataXml`, read on save). */
  metadata?: Record<string, unknown>;
  /** claim → user/member attribute mapping. */
  mapping?: Record<string, string>;
}

const RESERVED_SSO_IDS = new Set<string>([
  'credential',
  'email',
  'email-password',
  'magic-link',
  'passkey',
  'username',
  'anonymous',
  'phone-number',
  'siwe',
  ...SOCIAL_PROVIDERS,
]);

export async function upsertSsoProvider(ctx: OrgContext, input: UpsertSsoArgs): Promise<SsoProviderView> {
  const args = input.protocol === 'saml' ? normalizeSamlInput(input) : input;
  if (!/^[a-z0-9-]{2,40}$/.test(args.providerId)) {
    throw new Error('providerId must be a slug (a-z, 0-9, dash; 2–40 chars)');
  }
  // Mirrors @swarmy/auth account-linking RESERVED_PROVIDER_IDS (buildAuth also
  // skips such rows): an SSO provider sharing a built-in/social providerId
  // could answer with an existing account's subject and sign in as its owner.
  if (RESERVED_SSO_IDS.has(args.providerId)) {
    throw new Error(`providerId "${args.providerId}" is reserved — pick another name`);
  }
  const encryptedSecret = args.clientSecret ? encryptSecret(args.clientSecret) : undefined;

  if (args.id) {
    const existing = await ctx.db.ssoProvider.findFirst({
      where: { id: args.id, orgId: ctx.activeOrgId },
      select: { id: true, providerId: true },
    });
    if (!existing) throw notFound('sso provider', args.id);
    if (args.enabled === false) await assertSsoOnlyKeepsProvider(ctx, existing.providerId);
    const renamed = existing.providerId !== args.providerId;
    if (renamed) await assertProviderIdClaimable(ctx.db, ctx.activeOrgId, args.providerId);
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
    // The org's people keep signing in under the new id; the old one is retired.
    const moved = renamed
      ? await retireProviderId(ctx.db, ctx.activeOrgId, existing.providerId, { moveTo: row.providerId })
      : 0;
    await writeAudit(ctx, {
      action: 'sso.update',
      targetType: 'sso_provider',
      targetId: row.id,
      metadata: {
        providerId: row.providerId,
        protocol: row.protocol,
        ...(renamed ? { renamedFrom: existing.providerId, identitiesMoved: moved } : {}),
      },
    });
    return toView(row);
  }

  await assertProviderIdClaimable(ctx.db, ctx.activeOrgId, args.providerId);
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
    select: { id: true, providerId: true },
  });
  if (!row) throw notFound('sso provider', id);
  await assertSsoOnlyKeepsProvider(ctx, row.providerId);
  // Its identities go with it, and the id stays this org's (sso-identities.ts).
  const removed = await retireProviderId(ctx.db, ctx.activeOrgId, row.providerId);
  await ctx.db.ssoProvider.delete({ where: { id } });
  await writeAudit(ctx, {
    action: 'sso.delete',
    targetType: 'sso_provider',
    targetId: id,
    metadata: { providerId: row.providerId, identitiesRemoved: removed },
  });
  return { id, deleted: true };
}
