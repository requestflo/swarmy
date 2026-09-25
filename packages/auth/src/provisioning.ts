import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { setCookieCache } from 'better-auth/cookies';
import type { DB } from '@swarmy/db';
import { emailDomainAllowed, inviteAdmits, parseAllowedDomains } from './signup-policy';
import {
  displayEmail,
  groupsFromClaim,
  isLinkInviteEmail,
  INVITE_COOKIE,
  idpPlaceholderEmail,
  mapGroups,
  readCookie,
  usernamePlaceholderEmail,
} from './identity';
import type { ResolvedAuthConfig, ResolvedSsoProvider } from './config';

/**
 * Who joins which org, and with which groups, when they sign in.
 *
 *  - An open invite link (the `swarmy_invite` cookie) is redeemed by whatever
 *    sign-in follows it — password, username, social or SSO — and the invitee
 *    becomes a member with the invited role. The link is the credential; the
 *    invitee's email (if any) need not match.
 *  - An org SSO first login (`/oauth2/callback/<providerId>`) auto-provisions
 *    the person into the provider's org as a member (the IdP is the org's own
 *    directory; `metadata.autoProvision: false` turns it off).
 *  - Every SSO login replaces the member's `attributes.ssoGroups` with the
 *    IdP's group claim (mapped through `groupMap`), so ABAC policies over
 *    groups follow the directory. Admin-set `attributes.groups` are untouched.
 */

/** A host-injected audit sink (apps/api wires `writeAudit`); best-effort. */
export type AuthAudit = (
  orgId: string,
  entry: { action: string; targetType?: string; targetId?: string; actorId?: string | null; metadata?: Record<string, unknown> },
) => Promise<void>;

// genericOAuth's mapProfileToUser sees the IdP claims; the after-hook that
// knows the new session does not. Hand the groups across within the request
// (same process, milliseconds apart), keyed by provider + email, short TTL.
const PENDING_TTL_MS = 60_000;
const pendingGroups = new Map<string, { groups: string[]; at: number }>();

function pendingKey(providerId: string, email: string): string {
  return `${providerId}\u0000${email.toLowerCase()}`;
}

export function stashSsoGroups(providerId: string, email: string, groups: string[]): void {
  const now = Date.now();
  for (const [k, v] of pendingGroups) if (now - v.at > PENDING_TTL_MS) pendingGroups.delete(k);
  pendingGroups.set(pendingKey(providerId, email), { groups, at: now });
}

export function takeSsoGroups(providerId: string, email: string): string[] | null {
  const key = pendingKey(providerId, email);
  const hit = pendingGroups.get(key);
  pendingGroups.delete(key);
  if (!hit || Date.now() - hit.at > PENDING_TTL_MS) return null;
  return hit.groups;
}

/**
 * genericOAuth `mapProfileToUser` for an org SSO provider: the admin's claim
 * mapping, an email placeholder when the IdP sends none, and the group claim
 * stashed for the after-hook.
 */
export function ssoProfileMapper(p: ResolvedSsoProvider) {
  const mapping = p.mapping ?? {};
  const groupsClaim = mapping.groups || 'groups';
  return (profile: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [userField, claim] of Object.entries(mapping)) {
      if (userField === 'groups') continue;
      if (profile[claim] !== undefined) out[userField] = profile[claim];
    }
    const email = (out.email ?? profile.email) as string | undefined;
    const subject = String(profile.sub ?? profile.id ?? profile.oid ?? '');
    const finalEmail = email && String(email).includes('@') ? String(email) : idpPlaceholderEmail(p.providerId, subject);
    if (finalEmail !== email) out.email = finalEmail;
    if (!out.name && !profile.name) {
      out.name = String(profile.preferred_username ?? profile.nickname ?? subject ?? 'user');
    }
    stashSsoGroups(p.providerId, finalEmail, mapGroups(groupsFromClaim(profile, groupsClaim), p.groupMap));
    return out;
  };
}

/** Social providers: only fill in an email placeholder when the provider has none. */
export function socialProfileMapper(providerId: string) {
  return (profile: Record<string, unknown>): Record<string, unknown> => {
    const email = profile.email;
    if (typeof email === 'string' && email.includes('@')) return {};
    const subject = String(profile.id ?? profile.sub ?? profile.oid ?? '');
    return { email: idpPlaceholderEmail(providerId, subject) };
  };
}

type ProvisionDb = Pick<DB, 'member' | 'invitation' | 'session'> &
  Partial<Pick<DB, 'ssoProvider' | 'account' | 'organization'>>;

export type RedeemResult =
  | { ok: true; orgId: string; role: string }
  | { ok: false; reason: 'gone' | 'email_mismatch'; invitedEmail?: string };

/**
 * Redeem a pending, unexpired invitation (single-use). A link-only invite
 * admits whoever holds it; an invite naming an email admits only an account
 * with that address, verified, or carried by an SSO provider of the inviting
 * org ({@link inviteAdmits}). The pending → accepted flip is a conditional update,
 * so two redemptions of one link can't both succeed. Never demotes a member.
 */
export async function redeemInvitation(
  db: ProvisionDb,
  input: { invitationId: string; user: { id: string; email: string; emailVerified?: boolean | null } },
  audit?: AuthAudit,
  now: Date = new Date(),
): Promise<RedeemResult> {
  const inv = await db.invitation.findFirst({
    where: { id: input.invitationId, status: 'pending', expiresAt: { gt: now } },
    select: { id: true, organizationId: true, role: true, email: true },
  });
  if (!inv) return { ok: false, reason: 'gone' };
  const userId = input.user.id;
  let admitted = inviteAdmits(inv.email, { email: input.user.email, emailVerified: Boolean(input.user.emailVerified) });
  if (!admitted && db.account && db.ssoProvider) {
    // Not verified: only an identity from one of the INVITING org's own SSO
    // providers counts as proof. Any other IdP (social, another org's SSO) had
    // its chance to assert the address verified — which sets emailVerified.
    const orgProviders = await db.ssoProvider.findMany({
      where: { orgId: inv.organizationId },
      select: { providerId: true },
    });
    const ids = orgProviders.map((p) => p.providerId);
    const idp = ids.length
      ? await db.account.findFirst({ where: { userId, providerId: { in: ids } }, select: { id: true } })
      : null;
    admitted = inviteAdmits(
      inv.email,
      { email: input.user.email, idpOrgId: idp ? inv.organizationId : null },
      inv.organizationId,
    );
  }
  if (!admitted) return { ok: false, reason: 'email_mismatch', invitedEmail: displayEmail(inv.email) ?? undefined };

  const claimed = await db.invitation.updateMany({
    where: { id: inv.id, status: 'pending' },
    data: { status: 'accepted' },
  });
  if (claimed.count === 0) return { ok: false, reason: 'gone' };
  const role = inv.role === 'owner' || inv.role === 'admin' ? inv.role : 'member';
  const existing = await db.member.findFirst({
    where: { organizationId: inv.organizationId, userId },
    select: { id: true },
  });
  if (!existing) {
    await db.member.create({
      data: { id: randomUUID(), organizationId: inv.organizationId, userId, role },
    });
  }
  await audit?.(inv.organizationId, {
    action: 'member.invite.accept',
    targetType: 'invitation',
    targetId: inv.id,
    actorId: userId,
    metadata: { role, alreadyMember: Boolean(existing), kind: isLinkInviteEmail(inv.email) ? 'link' : 'email' },
  });
  return { ok: true, orgId: inv.organizationId, role };
}

/**
 * A social sign-in whose provider-verified email domain the provider's
 * `allowedDomains` accepts joins the controller's org as a member (one org
 * per controller: the oldest). No-op when they already belong somewhere.
 */
export async function provisionDomainMember(
  db: ProvisionDb,
  input: { userId: string; providerId: string },
  audit?: AuthAudit,
): Promise<{ orgId: string } | null> {
  const any = await db.member.findFirst({ where: { userId: input.userId }, select: { organizationId: true } });
  if (any) return null;
  const org = db.organization
    ? await db.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    : null;
  if (!org) return null;
  await db.member.create({
    data: { id: randomUUID(), organizationId: org.id, userId: input.userId, role: 'member' },
  });
  await audit?.(org.id, {
    action: 'member.domain.provision',
    targetType: 'user',
    targetId: input.userId,
    actorId: input.userId,
    metadata: { providerId: input.providerId },
  });
  return { orgId: org.id };
}

/** JIT-provision an SSO user into the provider's org and sync their SSO groups. */
export async function provisionSsoMember(
  db: ProvisionDb,
  input: { provider: Pick<ResolvedSsoProvider, 'providerId' | 'orgId' | 'autoProvision' | 'defaultRole'>; userId: string; groups: string[] | null },
  audit?: AuthAudit,
): Promise<{ orgId: string; created: boolean } | null> {
  const { provider } = input;
  const existing = await db.member.findFirst({
    where: { organizationId: provider.orgId, userId: input.userId },
    select: { id: true, attributes: true },
  });
  if (!existing && provider.autoProvision === false) return null;
  const attrs = ((existing?.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const nextAttrs = input.groups ? { ...attrs, ssoGroups: input.groups } : attrs;
  if (!existing) {
    await db.member.create({
      data: {
        id: randomUUID(),
        organizationId: provider.orgId,
        userId: input.userId,
        role: provider.defaultRole === 'admin' ? 'admin' : 'member',
        attributes: nextAttrs as object,
      },
    });
    await audit?.(provider.orgId, {
      action: 'member.sso.provision',
      targetType: 'user',
      targetId: input.userId,
      actorId: input.userId,
      metadata: { providerId: provider.providerId, groups: input.groups ?? [] },
    });
    return { orgId: provider.orgId, created: true };
  }
  const before = Array.isArray(attrs.ssoGroups) ? (attrs.ssoGroups as string[]) : [];
  if (input.groups && JSON.stringify(before) !== JSON.stringify(input.groups)) {
    await db.member.update({ where: { id: existing.id }, data: { attributes: nextAttrs as object } });
    await audit?.(provider.orgId, {
      action: 'member.sso.groups',
      targetType: 'user',
      targetId: input.userId,
      actorId: input.userId,
      metadata: { providerId: provider.providerId, groups: input.groups },
    });
  }
  return { orgId: provider.orgId, created: false };
}

function cookieHeader(ctx: { headers?: Headers | null; request?: Request | null } | null | undefined): string | null {
  return ctx?.headers?.get('cookie') ?? ctx?.request?.headers.get('cookie') ?? null;
}

/** The invite id the login page parked in a cookie, if any. */
export function inviteIdFromRequest(ctx: { headers?: Headers | null; request?: Request | null } | null | undefined): string | null {
  const id = readCookie(cookieHeader(ctx), INVITE_COOKIE);
  return id && /^[\w-]{1,128}$/.test(id) ? id : null;
}

/** `/oauth2/callback/:providerId` → the provider id. */
export function ssoProviderIdFromPath(path: string | undefined, params?: Record<string, unknown> | null): string | null {
  if (!path?.startsWith('/oauth2/callback/')) return null;
  const fromParams = params?.providerId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const tail = path.slice('/oauth2/callback/'.length);
  return tail && !tail.startsWith(':') ? tail : null;
}

/** `/callback/:id` (social OAuth) → the provider id. */
export function socialProviderFromPath(path: string | undefined, params?: Record<string, unknown> | null): string | null {
  if (!path?.startsWith('/callback/')) return null;
  const fromParams = params?.id;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const tail = path.slice('/callback/'.length);
  return tail && !tail.startsWith(':') ? tail : null;
}

/** A social provider's `allowedDomains` setting, parsed. */
export function allowedDomainsFor(social: ResolvedAuthConfig['social'] | undefined, providerId: string): string[] {
  const settings = (social as Record<string, { settings?: Record<string, string> } | undefined> | undefined)?.[providerId]?.settings;
  return parseAllowedDomains(settings?.allowedDomains);
}

/** Session-minting paths an invite cookie is redeemed on. */
function isSignInPath(path: string | undefined): boolean {
  if (!path) return false;
  return (
    path.startsWith('/sign-in/') ||
    path.startsWith('/sign-up/') ||
    path.startsWith('/callback/') ||
    path.startsWith('/oauth2/callback/') ||
    path.startsWith('/magic-link/verify') ||
    path.startsWith('/two-factor/verify')
  );
}

/**
 * The provisioning plugin: username-only sign-up (email placeholder), invite
 * redemption on any sign-in, and SSO JIT membership + group sync.
 */
export function swarmyProvisioning(
  db: ProvisionDb,
  opts: { sso: ResolvedSsoProvider[]; social?: ResolvedAuthConfig['social']; audit?: AuthAudit },
): BetterAuthPlugin {
  const byId = new Map(opts.sso.map((p) => [p.providerId, p]));
  return {
    id: 'swarmy-provisioning',
    hooks: {
      before: [
        {
          // Username accounts need no email: fill the reserved placeholder in
          // before Better Auth validates the body.
          matcher: (ctx) => ctx.path === '/sign-up/email',
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const email = typeof body.email === 'string' ? body.email.trim() : '';
            const username = typeof body.username === 'string' ? body.username.trim() : '';
            if (email || !username) return;
            return {
              context: {
                body: { ...body, email: usernamePlaceholderEmail(username), name: body.name || username },
              },
            };
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => isSignInPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created) return;
            const userId = created.user.id;
            let orgId: string | null = null;

            const providerId = ssoProviderIdFromPath(ctx.path, ctx.params as Record<string, unknown>);
            const provider = providerId ? byId.get(providerId) : undefined;
            if (provider) {
              const groups = takeSsoGroups(provider.providerId, created.user.email);
              const res = await provisionSsoMember(db, { provider, userId, groups }, opts.audit);
              orgId = res?.orgId ?? null;
            }

            const social = socialProviderFromPath(ctx.path, ctx.params as Record<string, unknown>);
            if (social && created.user.emailVerified) {
              const domains = allowedDomainsFor(opts.social, social);
              if (emailDomainAllowed(created.user.email, domains)) {
                const res = await provisionDomainMember(db, { userId, providerId: social }, opts.audit);
                orgId = res?.orgId ?? orgId;
              }
            }

            const inviteId = inviteIdFromRequest(ctx);
            if (inviteId) {
              const res = await redeemInvitation(
                db,
                { invitationId: inviteId, user: created.user as { id: string; email: string; emailVerified?: boolean } },
                opts.audit,
              );
              if (res.ok) orgId = res.orgId;
              // An email mismatch keeps the cookie so the page can explain it
              // (authConfig.acceptInvite answers with the reason).
              if (res.ok || res.reason === 'gone') ctx.setCookie(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
            }

            // Land the new session in the org it just joined.
            if (orgId && created.session.activeOrganizationId !== orgId) {
              await db.session.updateMany({
                where: { token: created.session.token },
                data: { activeOrganizationId: orgId },
              });
              // The endpoint already wrote the signed session_data cookie with
              // no active org; without a rewrite an SSO first login reads "No
              // active organization" until that cache expires (S78-8).
              const session = { ...created.session, activeOrganizationId: orgId };
              await setCookieCache(ctx, { session, user: created.user }, false);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
