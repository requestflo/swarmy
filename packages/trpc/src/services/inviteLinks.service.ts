/**
 * Shareable invite links (owner decision Q7): an admin mints a link with a
 * role, optionally one app, an expiry (1 d / 7 d / never) and a use count
 * (1 / 10 / unlimited). Whoever opens it and signs in joins the org with that
 * role; a member link that names an app also gets an `operator` grant on it
 * through the same `createGrant` path Settings → Access uses, so the seeded
 * "Resource operators can operate their resources" policy lets them ship that
 * app, production included.
 *
 * The token (`swi_<prefix>_<secret>`) is shown once in the URL; only its
 * sha-256 is stored. Redemption bumps `uses` with a compare-and-swap, so a
 * link can't admit more than `maxUses` people even under concurrent clicks. A
 * person already in the org is not re-added and doesn't burn a use.
 */
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { hashToken } from '@swarmy/core/crypto';
import {
  findInviteLink,
  INVITE_LINK_PREFIX,
  inviteLinkState,
  type InviteLinkRow,
  type InviteLinkState,
} from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AuthedContext, OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { stacks } from './apps.repo';
import { createGrant } from './members.service';
import { inviteLinkBase } from './invitations.service';

export const INVITE_LINK_ROLES = ['member', 'admin'] as const;
export type InviteLinkRole = (typeof INVITE_LINK_ROLES)[number];
export const INVITE_LINK_EXPIRIES = ['1d', '7d', 'never'] as const;
export type InviteLinkExpiry = (typeof INVITE_LINK_EXPIRIES)[number];

const EXPIRY_DAYS: Record<InviteLinkExpiry, number | null> = { '1d': 1, '7d': 7, never: null };

export interface InviteLinkView {
  id: string;
  prefix: string;
  role: InviteLinkRole;
  /** The one app it grants; null = the whole org (no app grant). */
  stackName: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  state: InviteLinkState;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
  /** The link with its token masked — the full URL is only returned at creation. */
  hint: string;
}

/** Returned ONCE at creation: carries the full URL with the plaintext token. */
export interface InviteLinkIssued extends InviteLinkView {
  url: string;
}

export function inviteLinkUrl(base: string, token: string): string {
  return `${base}/join/${encodeURIComponent(token)}`;
}

function toRole(role: string): InviteLinkRole {
  return role === 'admin' ? 'admin' : 'member';
}

function toView(
  row: InviteLinkRow & { prefix: string; createdAt: Date; createdBy?: { id: string; name: string | null } | null },
  base: string,
  now: Date,
): InviteLinkView {
  return {
    id: row.id,
    prefix: row.prefix,
    role: toRole(row.role),
    stackName: row.stackName,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    maxUses: row.maxUses,
    uses: row.uses,
    state: inviteLinkState(row, now),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ?? null,
    hint: `${base.replace(/^https?:\/\//, '')}/join/${INVITE_LINK_PREFIX}_${row.prefix}_…`,
  };
}

const VIEW_SELECT = {
  id: true,
  orgId: true,
  prefix: true,
  role: true,
  stackName: true,
  expiresAt: true,
  maxUses: true,
  uses: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/** The org's links that still matter: live ones, plus spent ones from the last week. */
export async function listInviteLinks(ctx: OrgContext, now: Date = new Date()): Promise<InviteLinkView[]> {
  const rows = await ctx.db.inviteLink.findMany({
    where: { orgId: ctx.activeOrgId, revokedAt: null },
    select: VIEW_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const base = inviteLinkBase(ctx.reqHeaders);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  return rows
    .map((r) => toView(r, base, now))
    .filter((v) => v.state === 'ok' || new Date(v.expiresAt ?? v.createdAt).getTime() > weekAgo);
}

export interface CreateInviteLinkInput {
  role: InviteLinkRole;
  /** One app (stack name); null/omitted = the whole org. */
  stackName?: string | null;
  expiry: InviteLinkExpiry;
  /** 1, 10, … ; null = unlimited. */
  maxUses: number | null;
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

export async function createInviteLink(
  ctx: OrgContext,
  input: CreateInviteLinkInput,
  now: Date = new Date(),
): Promise<InviteLinkIssued> {
  const stackName = input.stackName?.trim() || null;
  // An admin is org-wide by definition; an app only narrows a member.
  if (stackName && input.role === 'admin') throw badRequest('an admin link covers every app — pick Member to limit it to one app');
  if (input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
    throw badRequest('uses must be at least 1, or unlimited');
  }
  const prefix = randomBytes(4).toString('hex');
  const token = `${INVITE_LINK_PREFIX}_${prefix}_${randomBytes(24).toString('base64url')}`;
  const days = EXPIRY_DAYS[input.expiry];
  const row = await ctx.db.inviteLink.create({
    data: {
      orgId: ctx.activeOrgId,
      tokenHash: hashToken(token),
      prefix,
      role: input.role,
      stackName,
      expiresAt: days === null ? null : new Date(now.getTime() + days * 86_400_000),
      maxUses: input.maxUses,
      createdById: ctx.user.id,
    },
    select: VIEW_SELECT,
  });
  await writeAudit(ctx, {
    action: 'member.inviteLink.create',
    targetType: 'inviteLink',
    targetId: row.id,
    metadata: {
      role: input.role,
      stackName,
      maxUses: input.maxUses,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    },
  });
  const base = inviteLinkBase(ctx.reqHeaders);
  return { ...toView(row, base, now), url: inviteLinkUrl(base, token) };
}

/** Stop a link working now. People who already joined keep their access. */
export async function revokeInviteLink(ctx: OrgContext, id: string): Promise<{ id: string; revoked: true }> {
  const row = await ctx.db.inviteLink.findFirst({
    where: { id, orgId: ctx.activeOrgId, revokedAt: null },
    select: { id: true, uses: true },
  });
  if (!row) throw notFound('invite link', id);
  await ctx.db.inviteLink.update({ where: { id }, data: { revokedAt: new Date() } });
  await writeAudit(ctx, {
    action: 'member.inviteLink.revoke',
    targetType: 'inviteLink',
    targetId: id,
    metadata: { uses: row.uses },
  });
  return { id, revoked: true };
}

export interface InviteLinkPreview {
  kind: 'link';
  orgName: string;
  role: InviteLinkRole;
  stackName: string | null;
  state: InviteLinkState;
  expiresAt: string | null;
}

/** Public: what a link offers, before sign-in (the token is the credential). */
export async function inviteLinkPreview(db: DB, token: string, now: Date = new Date()): Promise<InviteLinkPreview | null> {
  const row = await findInviteLink(db, token);
  if (!row) return null;
  const org = await db.organization.findUnique({ where: { id: row.orgId }, select: { name: true } });
  if (!org) return null;
  return {
    kind: 'link',
    orgName: org.name,
    role: toRole(row.role),
    stackName: row.stackName,
    state: inviteLinkState(row, now),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

const STATE_MESSAGE: Record<Exclude<InviteLinkState, 'ok'>, string> = {
  expired: 'This invite link has expired. Ask an admin for a new one.',
  used: 'This invite link has been used as many times as it allows. Ask an admin for a new one.',
  revoked: 'This invite link was turned off. Ask an admin for a new one.',
};

/**
 * Claim one use: a compare-and-swap on `uses`, re-checking revoked/expiry in
 * the same conditional update. Retries a few times under contention.
 */
async function claimUse(db: DB, row: InviteLinkRow, now: Date): Promise<void> {
  let current = row;
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = inviteLinkState(current, now);
    if (state !== 'ok') throw badRequest(STATE_MESSAGE[state]);
    const res = await db.inviteLink.updateMany({
      where: {
        id: current.id,
        uses: current.uses,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { uses: current.uses + 1 },
    });
    if (res.count === 1) return;
    const fresh = await db.inviteLink.findUnique({
      where: { id: current.id },
      select: { id: true, orgId: true, role: true, stackName: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true },
    });
    if (!fresh) throw new TRPCError({ code: 'NOT_FOUND', message: 'This invite link no longer exists.' });
    current = fresh;
  }
  throw new TRPCError({ code: 'CONFLICT', message: 'Lots of people are using this link right now — try again.' });
}

/** The grant target for an app: its config-row id (what grants key on), else its name. */
async function stackResourceId(ctx: AuthedContext, orgId: string, stackName: string): Promise<string> {
  const row = await stacks(ctx, orgId)
    .findFirst({ where: { name: stackName, orgId }, select: { id: true } })
    .catch(() => null);
  return row?.id ?? stackName;
}

export interface AcceptInviteLinkResult {
  orgId: string;
  alreadyMember: boolean;
}

/**
 * Join the link's org as the signed-in user (and get its app grant). A person
 * who is already a member is left as they are and doesn't burn a use.
 */
export async function acceptInviteLink(
  ctx: AuthedContext,
  token: string,
  now: Date = new Date(),
): Promise<AcceptInviteLinkResult> {
  const row = await findInviteLink(ctx.db, token);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'This invite link does not exist. Ask an admin for a new one.' });
  const auditCtx = { db: ctx.db, activeOrgId: row.orgId, user: ctx.user };

  const existing = await ctx.db.member.findFirst({
    where: { organizationId: row.orgId, userId: ctx.user.id },
    select: { id: true },
  });
  if (existing) {
    await writeAudit(auditCtx, {
      action: 'member.inviteLink.accept',
      targetType: 'inviteLink',
      targetId: row.id,
      metadata: { alreadyMember: true },
    });
    return { orgId: row.orgId, alreadyMember: true };
  }

  await claimUse(ctx.db, row, now);
  const role = toRole(row.role);
  const member = await ctx.db.member.create({
    data: { id: crypto.randomUUID(), organizationId: row.orgId, userId: ctx.user.id, role },
    select: { id: true },
  });
  if (row.stackName && role === 'member') {
    const orgCtx = { ...ctx, activeOrgId: row.orgId, membership: { role, orgId: row.orgId } } as OrgContext;
    await createGrant(orgCtx, {
      principalType: 'member',
      principalId: member.id,
      resourceType: 'stack',
      resourceId: await stackResourceId(ctx, row.orgId, row.stackName),
      relation: 'operator',
    });
  }
  await writeAudit(auditCtx, {
    action: 'member.inviteLink.accept',
    targetType: 'inviteLink',
    targetId: row.id,
    metadata: { alreadyMember: false, role, stackName: row.stackName, memberId: member.id },
  });
  return { orgId: row.orgId, alreadyMember: false };
}
