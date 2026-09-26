/**
 * API key lifecycle (org-scoped machine identity for the public REST API).
 *
 * Mirrors the join-token security posture: the plaintext key (`swk_<prefix>_<secret>`)
 * is shown EXACTLY ONCE at creation; we persist only a sha-256 hash (via the shared
 * `@swarmy/core/crypto` vault) plus a displayable prefix. The key is never recoverable.
 */
import { hashToken, randomToken } from '@swarmy/core/crypto';
import {
  API_KEY_PRESETS,
  apiKeyExpiresAt,
  presetOf,
  type ApiKeyExpiry,
  type ApiKeyPreset,
  type ApiKeyScope,
} from '@swarmy/core';
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'node:crypto';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';

/** Wire prefix for swarmy API keys — greppable in logs / leak scanners. */
export const API_KEY_PREFIX = 'swk';

export type { ApiKeyScope } from '@swarmy/core';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  /** The dashboard preset these scopes match, or `custom` (CLI / older keys). */
  preset: ApiKeyPreset | 'custom';
  /** App (stack) names the key may reach; null = every app. */
  stackNames: string[] | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  createdById: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
}

/** Returned ONCE at creation — carries the plaintext key. */
export interface ApiKeyIssued extends ApiKeyView {
  /** Plaintext `swk_<prefix>_<secret>` — not stored, never returned again. */
  key: string;
}

/** A stored `stackNames` JSON value → a clean list, or null (every app). */
export function parseStackNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function toView(
  row: {
    id: string;
    name: string;
    prefix: string;
    scopes: unknown;
    stackNames?: unknown;
    lastUsedAt: Date | null;
    expiresAt?: Date | null;
    createdAt: Date;
    createdById: string | null;
    revokedAt: Date | null;
  },
  now: Date = new Date(),
): ApiKeyView {
  const scopes = ((row.scopes as ApiKeyScope[] | null) ?? ['read']) as ApiKeyScope[];
  const expired = Boolean(row.expiresAt && row.expiresAt.getTime() <= now.getTime());
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    preset: presetOf(scopes),
    stackNames: parseStackNames(row.stackNames),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: row.revokedAt ? 'revoked' : expired ? 'expired' : 'active',
  };
}

export interface CreateApiKeyInput {
  name: string;
  /** A dashboard preset; wins over `scopes`. */
  preset?: ApiKeyPreset;
  /** Raw scopes (REST / CLI). Defaults to read-only. */
  scopes?: ApiKeyScope[];
  /** Limit the key to these apps (stack names); omit/null = every app. */
  stackNames?: string[] | null;
  /** 30 d / 90 d / 1 y / never; omit = never (the REST default before Q7). */
  expiry?: ApiKeyExpiry;
  /** An explicit expiry (OAuth-minted keys); wins over `expiry`. */
  expiresAt?: Date | null;
}

const STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function cleanStackNames(input: string[] | null | undefined): string[] | null {
  if (input === undefined || input === null) return null;
  const names = [...new Set(input.map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'pick at least one app, or leave the key on every app' });
  }
  const bad = names.find((n) => !STACK_NAME.test(n));
  if (bad) throw new TRPCError({ code: 'BAD_REQUEST', message: `"${bad}" is not an app name` });
  return names;
}

export async function listApiKeys(ctx: OrgContext): Promise<ApiKeyView[]> {
  const rows = await ctx.db.apiKey.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => toView(r));
}

export async function createApiKey(ctx: OrgContext, input: CreateApiKeyInput): Promise<ApiKeyIssued> {
  const scopes = input.preset
    ? [...API_KEY_PRESETS[input.preset].scopes]
    : input.scopes && input.scopes.length
      ? [...new Set(input.scopes)]
      : (['read'] as ApiKeyScope[]);
  const stackNames = cleanStackNames(input.stackNames);
  const expiresAt =
    input.expiresAt !== undefined ? input.expiresAt : input.expiry ? apiKeyExpiresAt(input.expiry) : null;
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
      ...(stackNames ? { stackNames } : {}),
      expiresAt,
      createdById: ctx.user.id,
    },
  });
  await writeAudit(ctx, {
    action: 'apiKey.create',
    targetType: 'apiKey',
    targetId: row.id,
    metadata: {
      name: input.name,
      scopes,
      preset: presetOf(scopes),
      stackNames,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
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
