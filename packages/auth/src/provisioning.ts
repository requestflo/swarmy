import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { DB } from '@swarmy/db';
import {
  groupsFromClaim,
  INVITE_COOKIE,
  idpPlaceholderEmail,
  mapGroups,
  readCookie,
  usernamePlaceholderEmail,
} from './identity';
import type { ResolvedSsoProvider } from './config';

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

type ProvisionDb = Pick<DB, 'member' | 'invitation' | 'session'> & Partial<Pick<DB, 'ssoProvider'>>;

/**
 * Redeem a pending, unexpired invitation for `userId` (idempotent). Returns the
 * org joined, or null when the invite is gone. Never demotes an existing member.
 */
export async function redeemInvitation(
  db: ProvisionDb,
  input: { invitationId: string; userId: string },
  audit?: AuthAudit,
  now: Date = new Date(),
): Promise<{ orgId: string; role: string } | null> {
  const inv = await db.invitation.findFirst({
    where: { id: input.invitationId, status: 'pending', expiresAt: { gt: now } },
    select: { id: true, organizationId: true, role: true, email: true },
  });
  if (!inv) return null;
  const role = inv.role === 'owner' || inv.role === 'admin' ? inv.role : 'member';
  const existing = await db.member.findFirst({
    where: { organizationId: inv.organizationId, userId: input.userId },
    select: { id: true },
  });
  if (!existing) {
    await db.member.create({
      data: { id: randomUUID(), organizationId: inv.organizationId, userId: input.userId, role },
    });
  }
  await db.invitation.update({ where: { id: inv.id }, data: { status: 'accepted' } });
  await audit?.(inv.organizationId, {
    action: 'member.invite.accept',
    targetType: 'invitation',
    targetId: inv.id,
    actorId: input.userId,
    metadata: { role, alreadyMember: Boolean(existing) },
  });
  return { orgId: inv.organizationId, role };
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
  opts: { sso: ResolvedSsoProvider[]; audit?: AuthAudit },
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

            const inviteId = inviteIdFromRequest(ctx);
            if (inviteId) {
              const res = await redeemInvitation(db, { invitationId: inviteId, userId }, opts.audit);
              if (res) orgId = res.orgId;
              ctx.setCookie(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
            }

            // Land the new session in the org it just joined.
            if (orgId && created.session.activeOrganizationId !== orgId) {
              await db.session.updateMany({
                where: { token: created.session.token },
                data: { activeOrganizationId: orgId },
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
