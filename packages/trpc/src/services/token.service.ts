import { createHash, randomBytes } from 'node:crypto';
import { JOIN_TOKEN_PREFIX, parseNodeProfile, type NodeProfile } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface JoinTokenIssued {
  id: string;
  token: string;
  expiresAt: Date;
  maxUses: number;
  label: string | null;
  profile: NodeProfile | null;
}

export interface JoinTokenView {
  id: string;
  label: string | null;
  profile: NodeProfile | null;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: Date | null;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';
}

export async function generateJoinToken(
  ctx: OrgContext,
  args: { ttlSeconds?: number; maxUses?: number; label?: string; profile?: NodeProfile },
): Promise<JoinTokenIssued> {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`;
  const ttl = Math.min(args.ttlSeconds ?? 3600, 604_800);
  const maxUses = Math.min(args.maxUses ?? 1, 100);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  // 'default' is the absence of a profile — store null so the register path
  // has nothing to resolve.
  const profile = args.profile && args.profile !== 'default' ? args.profile : null;

  const row = await ctx.db.joinToken.create({
    data: {
      orgId: ctx.activeOrgId,
      tokenHash: hashToken(token),
      tokenPrefix: prefix,
      label: args.label ?? null,
      profile,
      maxUses,
      expiresAt,
      createdById: ctx.user.id,
    },
  });
  return { id: row.id, token, expiresAt, maxUses, label: row.label, profile };
}

function tokenStatus(row: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
}): JoinTokenView['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return 'expired';
  if (row.maxUses != null && row.uses >= row.maxUses) return 'exhausted';
  return 'active';
}

export async function listJoinTokens(ctx: OrgContext): Promise<JoinTokenView[]> {
  const rows = await ctx.db.joinToken.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    profile: parseNodeProfile(r.profile),
    tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    usedCount: r.uses,
    revokedAt: r.revokedAt,
    status: tokenStatus(r),
  }));
}

export async function revokeJoinToken(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; revoked: true }> {
  const row = await ctx.db.joinToken.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!row) throw notFound('join token', id);
  await ctx.db.joinToken.update({ where: { id }, data: { revokedAt: new Date() } });
  return { id, revoked: true };
}
