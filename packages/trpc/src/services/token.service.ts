import { createHash, randomBytes } from 'node:crypto';
import { JOIN_TOKEN_PREFIX, parseNodeProfile, type NodeProfile } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { mintSetupKeyForOrg } from './mesh.service';

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
  /**
   * NetBird setup key embedded for this token (epic: zero-trust-networking,
   * mesh-first join), when the org has mesh enabled. Present only in this
   * one-shot response — never persisted on the `JoinToken` row — mirroring the
   * raw `token` field's reveal-once discipline.
   */
  meshSetupKey?: string;
  meshManagementUrl?: string;
  meshDriver?: string;
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
  const expiresAt = new Date(Date.now() + ttl * 1000);
  // 'default' is the absence of a profile — store null so the register path
  // has nothing to resolve.
  const profile = args.profile && args.profile !== 'default' ? args.profile : null;

  // Mesh-first join (epic: zero-trust-networking): mint a NetBird setup key
  // when the org has mesh enabled, so the install one-liner can carry it and
  // the agent joins the mesh before registering. `null` when mesh is off —
  // the opt-in gate; the token then behaves exactly as before this feature.
  const mesh = await mintSetupKeyForOrg(ctx);
  // NetBird setup keys are single-use — a multi-use token would silently fail
  // to enroll every node after the first. Force maxUses=1 whenever a key is
  // embedded (surfaced in the dashboard as "single-use because mesh is enabled").
  const maxUses = mesh ? 1 : Math.min(args.maxUses ?? 1, 100);

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
  return {
    id: row.id,
    token,
    expiresAt,
    maxUses,
    label: row.label,
    profile,
    ...(mesh
      ? { meshSetupKey: mesh.setupKey, meshManagementUrl: mesh.managementUrl, meshDriver: mesh.driver }
      : {}),
  };
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
