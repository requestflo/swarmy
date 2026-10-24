import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { normaliseBaseUrl, resolveControllerPublicUrl } from '@swarmy/core';
import { displayEmail, invitePlaceholderEmail, isLinkInviteEmail } from '@swarmy/auth';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { sendSystemEmail } from './email/runtime';
import { inviteStackName } from './invite-grant';

/**
 * Org invitations as copyable links. An admin mints a Better Auth organization
 * invitation here and hands the `/login?invite=<id>` link to the invitee; when
 * the email service is on, an email-named invite is also mailed to that
 * address (swarmy's own mail, email/runtime.ts `sendSystemEmail`). Email is optional: a
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
  /** The one app it scopes a member to (an `operator` grant on accept); null = the whole org. */
  stackName: string | null;
  /** An email invite was also mailed (the email service is on); absent otherwise. */
  emailed?: boolean;
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

export interface InvitationRow {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  stackName?: string | null;
  inviter?: { id: string; name: string | null; email: string | null } | null;
}

export function toView(row: InvitationRow, base: string, now: Date): InvitationView {
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
    stackName: row.stackName ?? null,
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
  /** One app to scope a member to, as an app-scoped invite link does. Members only. */
  stackName?: string | null;
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
  const stackName = inviteStackName(args.role, args.stackName);
  if (!given) {
    const row = await createViaAuth(ctx, invitePlaceholderEmail(randomBytes(9).toString('base64url')), args.role, stackName);
    await writeAudit(ctx, {
      action: 'member.invite',
      targetType: 'invitation',
      targetId: row.id,
      metadata: { kind: 'link', role: args.role, stackName, expiresAt: row.expiresAt.toISOString() },
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

  const row = await createViaAuth(ctx, email, args.role, stackName);
  const view = toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
  const emailed = await mailInvite(ctx, view);
  await writeAudit(ctx, {
    action: 'member.invite',
    targetType: 'invitation',
    targetId: row.id,
    metadata: { email, role: args.role, stackName, expiresAt: row.expiresAt.toISOString(), emailed },
  });
  return { ...view, emailed };
}

/**
 * Mail an email-named invite through swarmy's email service (when it is on).
 * Best-effort: the copyable link stays the primary path, so a failed or
 * skipped send never fails the invite.
 */
export async function mailInvite(ctx: OrgContext, view: InvitationView): Promise<boolean> {
  if (!view.email || view.kind !== 'email') return false;
  let org: { name: string } | null = null;
  try {
    org = await ctx.db.organization.findUnique({ where: { id: ctx.activeOrgId }, select: { name: true } });
  } catch {
    org = null;
  }
  const who = ctx.user.name || displayEmail(ctx.user.email) || 'Someone';
  const orgName = org?.name ?? 'their organization';
  const days = Math.max(1, Math.round((view.expiresAt.getTime() - Date.now()) / 86_400_000));
  const r = await sendSystemEmail(ctx.db, {
    orgId: ctx.activeOrgId,
    to: view.email,
    subject: `${who} invited you to ${orgName} on swarmy`,
    text:
      `${who} invited you to join ${orgName} on swarmy as ${view.role === 'member' ? 'a member' : `an ${view.role}`}` +
      `${view.stackName ? `, working on ${view.stackName}` : ''}.\n\n` +
      `Accept the invite: ${view.link}\n\n` +
      `The link works once and expires in ${days} day${days === 1 ? '' : 's'}. ` +
      'Sign in with this email address (or an SSO/social account that uses it). If you did not expect this, ignore it.',
  });
  return r.sent;
}

async function createViaAuth(ctx: OrgContext, email: string, role: InviteRole, stackName: string | null = null): Promise<InvitationRow> {
  let created: { id: string; email: string; role: string; status: string; expiresAt: Date };
  try {
    created = await ctx.auth.api.createInvitation({
      headers: ctx.reqHeaders,
      body: { email, role, organizationId: ctx.activeOrgId },
    });
  } catch (e) {
    throw badRequest(authErrorMessage(e, 'could not create the invitation'));
  }
  // The app scope is swarmy's column on Better Auth's row (Better Auth ignores it).
  if (stackName) await ctx.db.invitation.update({ where: { id: created.id }, data: { stackName } });
  return {
    id: created.id,
    email: created.email,
    role: created.role,
    status: created.status,
    expiresAt: new Date(created.expiresAt),
    createdAt: new Date(),
    stackName,
    inviter: { id: ctx.user.id, name: ctx.user.name ?? null, email: ctx.user.email ?? null },
  };
}

export async function findPendingOrThrow(ctx: OrgContext, id: string): Promise<InvitationRow> {
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
  const stackName = role === 'member' ? (old.stackName ?? null) : null;
  const row = await createViaAuth(ctx, email, role, stackName);
  const view = toView(row, inviteLinkBase(ctx.reqHeaders), new Date());
  const emailed = await mailInvite(ctx, view);
  await writeAudit(ctx, {
    action: 'member.invite.regenerate',
    targetType: 'invitation',
    targetId: row.id,
    metadata: { email: displayEmail(old.email), role, stackName, replaced: id, expiresAt: row.expiresAt.toISOString(), emailed },
  });
  return { ...view, emailed };
}
