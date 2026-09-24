/**
 * Org-level third-party registry credentials: CRUD + test + the JIT resolver
 * the hub dispatch decorator uses (`registry-auth.ts`).
 *
 * Write-only secret UX: the token is vault-encrypted on write and NEVER leaves
 * the controller except inside an agent command payload at dispatch. Views carry
 * `prefix`/`username`/test status only. Delete is gated `secret.delete`
 * (abacProcedure / requireAction) at the router/REST boundary.
 */
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { RegistryAuth } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  REGISTRY_PROVIDERS,
  buildPullAuths,
  guessProvider,
  matchCredential,
  normalizeRegistryPrefix,
  testRegistryLogin,
  toRegistryAuth,
  type RegistryProvider,
  type RegistryTestResult,
  type ResolvedCredential,
} from './registry-credentials';

export interface RegistryCredentialView {
  id: string;
  prefix: string;
  provider: RegistryProvider;
  label: string | null;
  username: string;
  /** Always true — the secret exists but is never returned. */
  hasSecret: true;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  id: string;
  prefix: string;
  provider: string;
  label: string | null;
  username: string;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const VIEW_SELECT = {
  id: true,
  prefix: true,
  provider: true,
  label: true,
  username: true,
  lastTestedAt: true,
  lastTestOk: true,
  lastTestMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

function asProvider(p: string, prefix: string): RegistryProvider {
  return (REGISTRY_PROVIDERS as readonly string[]).includes(p) ? (p as RegistryProvider) : guessProvider(prefix);
}

export function toCredentialView(r: Row): RegistryCredentialView {
  return {
    id: r.id,
    prefix: r.prefix,
    provider: asProvider(r.provider, r.prefix),
    label: r.label,
    username: r.username,
    hasSecret: true,
    lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
    lastTestOk: r.lastTestOk,
    lastTestMessage: r.lastTestMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function badPrefix(input: string): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: `"${input}" is not a registry host (e.g. ghcr.io, docker.io, registry.gitlab.com/group)`,
  });
}

// ── Decorator cache (per-org, short TTL, invalidated on every write) ────────

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; creds: ResolvedCredential[] }>();

export function invalidateRegistryCredentialCache(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

/** Decrypted creds for an org (controller-only). Undecryptable rows are skipped. */
export async function loadOrgRegistryCredentials(db: DB, orgId: string): Promise<ResolvedCredential[]> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.creds;
  const rows = await db.registryCredential.findMany({
    where: { orgId },
    select: { prefix: true, username: true, secretEnc: true },
  });
  const creds: ResolvedCredential[] = [];
  for (const r of rows) {
    try {
      creds.push({ prefix: r.prefix, username: r.username, secret: decryptSecret(r.secretEnc) });
    } catch {
      /* rotated SWARMY_SECRET_KEY / corrupt row — skip, never block a deploy */
    }
  }
  cache.set(orgId, { at: Date.now(), creds });
  return creds;
}

/** The JIT resolver: pull auth for one image ref, or null (public / no match). */
export async function resolveRegistryAuthFor(db: DB, orgId: string, image: string): Promise<RegistryAuth | null> {
  const hit = matchCredential(image, await loadOrgRegistryCredentials(db, orgId));
  return hit ? toRegistryAuth(hit) : null;
}

/** Every org credential as build `pullAuths` (private `FROM` bases). */
export async function resolveBuildPullAuths(db: DB, orgId: string): Promise<RegistryAuth[]> {
  return buildPullAuths(await loadOrgRegistryCredentials(db, orgId));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listRegistryCredentials(ctx: OrgContext): Promise<RegistryCredentialView[]> {
  const rows = await ctx.db.registryCredential.findMany({
    where: { orgId: ctx.activeOrgId },
    select: VIEW_SELECT,
    orderBy: { prefix: 'asc' },
  });
  return rows.map(toCredentialView);
}

export interface UpsertRegistryCredentialInput {
  prefix: string;
  username: string;
  secret: string;
  provider?: RegistryProvider;
  label?: string | null;
}

/** Create — or replace the login for an existing prefix (a rotation). */
export async function upsertRegistryCredential(
  ctx: OrgContext,
  input: UpsertRegistryCredentialInput,
): Promise<RegistryCredentialView> {
  const prefix = normalizeRegistryPrefix(input.prefix);
  if (!prefix) throw badPrefix(input.prefix);
  const provider = input.provider ?? guessProvider(prefix);
  const existing = await ctx.db.registryCredential.findUnique({
    where: { orgId_prefix: { orgId: ctx.activeOrgId, prefix } },
    select: { id: true },
  });
  const data = {
    username: input.username,
    secretEnc: encryptSecret(input.secret),
    provider,
    label: input.label ?? null,
    lastTestedAt: null,
    lastTestOk: null,
    lastTestMessage: null,
  };
  const row = existing
    ? await ctx.db.registryCredential.update({ where: { id: existing.id }, data, select: VIEW_SELECT })
    : await ctx.db.registryCredential.create({
        data: { ...data, orgId: ctx.activeOrgId, prefix, createdById: ctx.user?.id ?? null },
        select: VIEW_SELECT,
      });
  invalidateRegistryCredentialCache(ctx.activeOrgId);
  await writeAudit(ctx, {
    action: existing ? 'registry.credential.rotate' : 'registry.credential.create',
    targetType: 'registryCredential',
    targetId: row.id,
    metadata: { prefix, provider, username: input.username },
  });
  return toCredentialView(row);
}

/** Update username/label and optionally rotate the secret (omit to keep it). */
export async function updateRegistryCredential(
  ctx: OrgContext,
  input: { id: string; username?: string; secret?: string; label?: string | null; provider?: RegistryProvider },
): Promise<RegistryCredentialView> {
  const existing = await ctx.db.registryCredential.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    select: { id: true, prefix: true },
  });
  if (!existing) throw notFound('registryCredential', input.id);
  const rotated = input.secret !== undefined || input.username !== undefined;
  const row = await ctx.db.registryCredential.update({
    where: { id: existing.id },
    data: {
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.secret !== undefined ? { secretEnc: encryptSecret(input.secret) } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(rotated ? { lastTestedAt: null, lastTestOk: null, lastTestMessage: null } : {}),
    },
    select: VIEW_SELECT,
  });
  invalidateRegistryCredentialCache(ctx.activeOrgId);
  await writeAudit(ctx, {
    action: input.secret !== undefined ? 'registry.credential.rotate' : 'registry.credential.update',
    targetType: 'registryCredential',
    targetId: row.id,
    metadata: { prefix: existing.prefix },
  });
  return toCredentialView(row);
}

export async function deleteRegistryCredential(ctx: OrgContext, id: string): Promise<{ ok: true }> {
  const existing = await ctx.db.registryCredential.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, prefix: true },
  });
  if (!existing) throw notFound('registryCredential', id);
  await ctx.db.registryCredential.delete({ where: { id: existing.id } });
  invalidateRegistryCredentialCache(ctx.activeOrgId);
  await writeAudit(ctx, {
    action: 'registry.credential.delete',
    targetType: 'registryCredential',
    targetId: id,
    metadata: { prefix: existing.prefix },
  });
  return { ok: true };
}

/**
 * "Test credentials": run the v2 auth handshake from the controller for a
 * stored credential (or an unsaved draft), optionally HEADing `image`'s
 * manifest. A stored credential's last result is persisted for the list view.
 */
export async function testRegistryCredential(
  ctx: OrgContext,
  input:
    | { id: string; image?: string }
    | { prefix: string; username: string; secret: string; image?: string },
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<RegistryTestResult> {
  let login: { prefix: string; username: string; secret: string };
  let id: string | null = null;
  if ('id' in input) {
    const row = await ctx.db.registryCredential.findFirst({
      where: { id: input.id, orgId: ctx.activeOrgId },
      select: { id: true, prefix: true, username: true, secretEnc: true },
    });
    if (!row) throw notFound('registryCredential', input.id);
    id = row.id;
    let secret: string;
    try {
      secret = decryptSecret(row.secretEnc);
    } catch {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'stored token cannot be decrypted — re-enter it' });
    }
    login = { prefix: row.prefix, username: row.username, secret };
  } else {
    const prefix = normalizeRegistryPrefix(input.prefix);
    if (!prefix) throw badPrefix(input.prefix);
    login = { prefix, username: input.username, secret: input.secret };
  }
  const result = await testRegistryLogin({ ...login, image: input.image || undefined }, fetchImpl);
  if (id) {
    await ctx.db.registryCredential.update({
      where: { id },
      data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message },
    });
  }
  await writeAudit(ctx, {
    action: 'registry.credential.test',
    targetType: 'registryCredential',
    targetId: id ?? undefined,
    metadata: { prefix: login.prefix, ok: result.ok, status: result.status },
  });
  return result;
}
