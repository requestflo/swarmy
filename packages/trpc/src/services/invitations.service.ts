import { TRPCError } from '@trpc/server';
import { normaliseBaseUrl, resolveControllerPublicUrl } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Org invitations as copyable links. A self-hosted controller has no mailer, so
 * an admin mints a Better Auth organization invitation here and hands the
 * `/login?invite=<id>` link to the invitee themselves. The login page accepts the
 * invitation after sign-up (or sign-in for an existing account); the sign-up
 * policy (`@swarmy/auth` signup-policy) admits the invited email on an
 * invite-only controller because the invitation is pending and unexpired.
 *
 * Creation goes through `auth.api.createInvitation` with the caller's headers so
 * Better Auth's own permission model applies (only an owner may invite an owner,
 * expiry from `invitationExpiresIn`). Listing/revoking read the org-scoped
 * `invitation` table directly.
 */

export type InviteRole = 'owner' | 'admin' | 'member';

export interface InvitationView {
  id: string;
  email: string;
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
    email: row.email,
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
  email: string;
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
  const email = args.email.trim().toLowerCase();
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
    metadata: { email: row.email },
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
  const row = await createViaAuth(ctx, old.email, role);
  await writeAudit(ctx, {
    action: 'member.invite.regenerate',
    targetType: 'invitation',
    targetId: row.id,
    metadata: { email: old.email, role, replaced: id, expiresAt: row.expiresAt.toISOString() },
  });
  return toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
}
