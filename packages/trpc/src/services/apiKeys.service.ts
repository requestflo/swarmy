/**
 * API key lifecycle (org-scoped machine identity for the public REST API).
 *
 * Mirrors the join-token security posture: the plaintext key (`swk_<prefix>_<secret>`)
 * is shown EXACTLY ONCE at creation; we persist only a sha-256 hash (via the shared
 * `@swarmy/core/crypto` vault) plus a displayable prefix. The key is never recoverable.
 */
import { hashToken, randomToken } from '@swarmy/core/crypto';
import { randomBytes } from 'node:crypto';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/** Wire prefix for swarmy API keys — greppable in logs / leak scanners. */
export const API_KEY_PREFIX = 'swk';

export type ApiKeyScope = 'read' | 'write';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  createdAt: string;
  createdById: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

/** Returned ONCE at creation — carries the plaintext key. */
export interface ApiKeyIssued extends ApiKeyView {
  /** Plaintext `swk_<prefix>_<secret>` — not stored, never returned again. */
  key: string;
}

function toView(row: {
  id: string;
  name: string;
  prefix: string;
  scopes: unknown;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdById: string | null;
  revokedAt: Date | null;
}): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: ((row.scopes as ApiKeyScope[] | null) ?? ['read']) as ApiKeyScope[],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: row.revokedAt ? 'revoked' : 'active',
  };
}

export async function listApiKeys(ctx: OrgContext): Promise<ApiKeyView[]> {
  const rows = await ctx.db.apiKey.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

export async function createApiKey(
  ctx: OrgContext,
  input: { name: string; scopes?: ApiKeyScope[] },
): Promise<ApiKeyIssued> {
  const scopes = input.scopes && input.scopes.length ? input.scopes : (['read'] as ApiKeyScope[]);
  // `swk_<prefix>_<secret>` — prefix is stored & displayed, the whole string is hashed.
  const prefix = randomBytes(4).toString('hex');
  const secret = randomToken(API_KEY_PREFIX); // swk_<base64url>
  const key = `${API_KEY_PREFIX}_${prefix}_${secret.slice(API_KEY_PREFIX.length + 1)}`;

  const row = await ctx.db.apiKey.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      keyHash: hashToken(key),
      prefix,
      scopes,
      createdById: ctx.user.id,
    },
  });
  await writeAudit(ctx, {
    action: 'apiKey.create',
    targetType: 'apiKey',
    targetId: row.id,
    metadata: { name: input.name, scopes },
  });
  return { ...toView(row), key };
}

export async function revokeApiKey(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; revoked: true }> {
  const row = await ctx.db.apiKey.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!row) throw notFound('api key', id);
  await ctx.db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await writeAudit(ctx, { action: 'apiKey.revoke', targetType: 'apiKey', targetId: id });
  return { id, revoked: true };
}
