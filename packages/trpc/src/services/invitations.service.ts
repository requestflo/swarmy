import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { normaliseBaseUrl, resolveControllerPublicUrl } from '@swarmy/core';
import { displayEmail, invitePlaceholderEmail, isLinkInviteEmail, redeemInvitation } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AuthedContext, OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Org invitations as copyable links. A self-hosted controller has no mailer, so
 * an admin mints a Better Auth organization invitation here and hands the
 * `/login?invite=<id>` link to the invitee themselves. Email is optional: a
 * link-only invite carries a reserved placeholder address, and the link itself
 * is the credential. Whoever opens it can sign up or sign in by any method
 * (username, password, social, SSO) and joins with the invited role; the
 * sign-in hook (`@swarmy/auth` provisioning) redeems it, and `acceptInvitation`
 * below is the idempotent fallback the login page calls.
 *
 * Creation goes through `auth.api.createInvitation` with the caller's headers so
 * Better Auth's own permission model applies (only an owner may invite an owner,
 * expiry from `invitationExpiresIn`). Listing/revoking read the org-scoped
 * `invitation` table directly.
 */

export type InviteRole = 'owner' | 'admin' | 'member';

export interface InvitationView {
  id: string;
  /** null for a link-only invite (no email). */
  email: string | null;
  kind: 'link' | 'email';
  role: InviteRole;
  /** `pending` = still redeemable; `expired` = pending row past its expiry. */
  status: 'pending' | 'expired';
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { id: string; name: string | null; email: string | null } | null;
  /** The copyable link: `<controller public url>/login?invite=<id>`. */
  link: string;
}

/**
 * Base URL the invite link should open. `CONTROLLER_PUBLIC_URL` (or the proxy /
 * host the request reached) as the install one-liner resolves it; when that is
 * only loopback, prefer the dashboard's own Origin so `bun dev` links open the
 * dashboard (:3023) rather than the API (:3021).
 */
export function inviteLinkBase(headers: Headers | undefined, env: Record<string, string | undefined> = process.env): string {
  const resolved = resolveControllerPublicUrl({ configured: env.CONTROLLER_PUBLIC_URL, headers });
  const origin = normaliseBaseUrl(headers?.get('origin'));
  return resolved.loopback && origin ? origin : resolved.url;
}

export function inviteLink(base: string, invitationId: string): string {
  return `${base}/login?invite=${encodeURIComponent(invitationId)}`;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviter?: { id: string; name: string | null; email: string | null } | null;
}

function toView(row: InvitationRow, base: string, now: Date): InvitationView {
  return {
    id: row.id,
    email: displayEmail(row.email),
    kind: isLinkInviteEmail(row.email) ? 'link' : 'email',
    role: (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as InviteRole,
    status: row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending',
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    invitedBy: row.inviter ?? null,
    link: inviteLink(base, row.id),
  };
}

const INVITER_SELECT = { select: { id: true, name: true, email: true } } as const;

/** Pending (redeemable + expired) invitations for the active org, newest first. */
export async function listInvitations(ctx: OrgContext, now: Date = new Date()): Promise<InvitationView[]> {
  const rows = await ctx.db.invitation.findMany({
    where: { organizationId: ctx.activeOrgId, status: 'pending' },
    include: { inviter: INVITER_SELECT },
    orderBy: { createdAt: 'desc' },
  });
  const base = inviteLinkBase(ctx.reqHeaders);
  return rows.map((r) => toView(r, base, now));
}

export interface InviteArgs {
  /** Optional. Omit for a link-only invite (the invitee may have no email). */
  email?: string | null;
  role: InviteRole;
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Better Auth surfaces `APIError` with a `body.message`; unwrap it for the UI. */
function authErrorMessage(e: unknown, fallback: string): string {
  const body = (e as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return e instanceof Error && e.message ? e.message : fallback;
}

export async function inviteMember(ctx: OrgContext, args: InviteArgs): Promise<InvitationView> {
  const given = args.email?.trim().toLowerCase();
  if (!given) {
    const row = await createViaAuth(ctx, invitePlaceholderEmail(randomBytes(9).toString('base64url')), args.role);
    await writeAudit(ctx, {
      action: 'member.invite',
      targetType: 'invitation',
      targetId: row.id,
      metadata: { kind: 'link', role: args.role, expiresAt: row.expiresAt.toISOString() },
    });
    return toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
  }
  const email = given;
  const existing = await ctx.db.member.findFirst({
    where: { organizationId: ctx.activeOrgId, user: { email } },
    select: { id: true },
  });
  if (existing) throw badRequest(`${email} is already a member of this org`);

  const pending = await ctx.db.invitation.findFirst({
    where: { organizationId: ctx.activeOrgId, email, status: 'pending', expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (pending) throw badRequest(`${email} already has a pending invite — copy or regenerate its link below`);

  const row = await createViaAuth(ctx, email, args.role);
  await writeAudit(ctx, {
    action: 'member.invite',
    targetType: 'invitation',
    targetId: row.id,
    metadata: { email, role: args.role, expiresAt: row.expiresAt.toISOString() },
  });
  return toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
}

async function createViaAuth(ctx: OrgContext, email: string, role: InviteRole): Promise<InvitationRow> {
  let created: { id: string; email: string; role: string; status: string; expiresAt: Date };
  try {
    created = await ctx.auth.api.createInvitation({
      headers: ctx.reqHeaders,
      body: { email, role, organizationId: ctx.activeOrgId },
    });
  } catch (e) {
    throw badRequest(authErrorMessage(e, 'could not create the invitation'));
  }
  return {
    id: created.id,
    email: created.email,
    role: created.role,
    status: created.status,
    expiresAt: new Date(created.expiresAt),
    createdAt: new Date(),
    inviter: { id: ctx.user.id, name: ctx.user.name ?? null, email: ctx.user.email ?? null },
  };
}

async function findPendingOrThrow(ctx: OrgContext, id: string): Promise<InvitationRow> {
  const row = await ctx.db.invitation.findFirst({
    where: { id, organizationId: ctx.activeOrgId, status: 'pending' },
    include: { inviter: INVITER_SELECT },
  });
  if (!row) throw notFound('invitation', id);
  return row;
}

/** Cancel a pending invitation; its link stops working immediately. */
export async function revokeInvitation(ctx: OrgContext, id: string): Promise<{ id: string; revoked: true }> {
  const row = await findPendingOrThrow(ctx, id);
  await ctx.db.invitation.update({ where: { id }, data: { status: 'canceled' } });
  await writeAudit(ctx, {
    action: 'member.invite.revoke',
    targetType: 'invitation',
    targetId: id,
    metadata: { email: displayEmail(row.email) },
  });
  return { id, revoked: true };
}

/**
 * Replace an invitation with a fresh one (new id, fresh expiry) for the same
 * email + role. The old link stops working; the new one is returned.
 */
export async function regenerateInvitation(ctx: OrgContext, id: string): Promise<InvitationView> {
  const old = await findPendingOrThrow(ctx, id);
  await ctx.db.invitation.update({ where: { id }, data: { status: 'canceled' } });
  const role = (old.role === 'owner' || old.role === 'admin' ? old.role : 'member') as InviteRole;
  // A link-only invite gets a fresh placeholder so the old one can't collide.
  const email = isLinkInviteEmail(old.email) ? invitePlaceholderEmail(randomBytes(9).toString('base64url')) : old.email;
  const row = await createViaAuth(ctx, email, role);
  await writeAudit(ctx, {
    action: 'member.invite.regenerate',
    targetType: 'invitation',
    targetId: row.id,
    metadata: { email: displayEmail(old.email), role, replaced: id, expiresAt: row.expiresAt.toISOString() },
  });
  return toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
}

/** What an invite link shows before sign-in. */
export interface InvitationPreview {
  orgName: string;
  role: InviteRole;
  /** The invited address, when the invite named one. */
  email: string | null;
  expired: boolean;
}

/** Public preview of an invite link (the unguessable id is the credential). */
export async function invitationPreview(db: DB, id: string, now: Date = new Date()): Promise<InvitationPreview | null> {
  const row = await db.invitation.findFirst({
    where: { id, status: 'pending' },
    select: { role: true, email: true, expiresAt: true, organization: { select: { name: true } } },
  });
  if (!row) return null;
  return {
    orgName: row.organization.name,
    role: (row.role === 'owner' || row.role === 'admin' ? row.role : 'member') as InviteRole,
    email: displayEmail(row.email),
    expired: row.expiresAt.getTime() <= now.getTime(),
  };
}

/**
 * Redeem an invite link for the signed-in user and activate its org. A
 * link-only invite works for any sign-in method; one that names an email
 * needs that address verified or carried by the SSO/social identity used.
 * Idempotent: when the sign-in hook already redeemed it, the user's
 * membership answers.
 */
export async function acceptInvitation(ctx: AuthedContext, id: string): Promise<{ orgId: string }> {
  const redeemed = await redeemInvitation(
    ctx.db,
    { invitationId: id, user: { id: ctx.user.id, email: ctx.user.email, emailVerified: ctx.user.emailVerified } },
    (orgId, entry) => writeAudit({ db: ctx.db, activeOrgId: orgId, user: ctx.user }, entry),
  );
  if (!redeemed.ok && redeemed.reason === 'email_mismatch') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This invite is for ${redeemed.invitedEmail ?? 'a specific email address'}. Sign in with an SSO or social account that uses that address.`,
      cause: { swarmyCode: 'INVITE_EMAIL_MISMATCH' },
    });
  }
  let orgId = redeemed.ok ? redeemed.orgId : null;
  if (!orgId) {
    // Already redeemed (by the sign-in hook, or a second click): find the org.
    const inv = await ctx.db.invitation.findFirst({
      where: { id, status: 'accepted' },
      select: { organizationId: true },
    });
    const member = inv
      ? await ctx.db.member.findFirst({
          where: { organizationId: inv.organizationId, userId: ctx.user.id },
          select: { organizationId: true },
        })
      : null;
    if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'This invite link has expired or was revoked.' });
    orgId = member.organizationId;
  }
  await ctx.auth.api.setActiveOrganization({ headers: ctx.reqHeaders, body: { organizationId: orgId } });
  return { orgId };
}
