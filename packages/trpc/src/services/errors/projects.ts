/**
 * Error projects — one Sentry DSN per app (stack).
 *
 * `ErrorProject` (control.db) is identity only: org + stack ↔ numeric project
 * id, and the DSN public key (sha-256 for ingest, vault-sealed for display).
 * Sentry calls the key "public" — it ships inside browser bundles — so it
 * authenticates *which project* an event is for, not a user; abuse is capped
 * by the per-project rate limit.
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashToken, encryptSecret, decryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../../context';
import { writeAudit } from '../audit.service';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;

export interface ErrorProjectView {
  stack: string;
  projectId: number;
  dsn: string;
  rateLimitPerMinute: number;
  createdAt: string;
  rotatedAt: string | null;
}

interface ProjectRow {
  id: string;
  orgId: string;
  stack: string;
  projectId: number;
  keyHash: string;
  keyEnc: string;
  rateLimitPerMinute: number;
  rotatedAt: Date | null;
  createdAt: Date;
}

/** The controller's public base URL (what SDKs — browsers included — can reach). */
export function controllerPublicUrl(): string {
  return (process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
}

/** `https://<key>@<host>[/<prefix>]/<projectId>` — the SDK derives `/api/<id>/envelope/` from it. */
export function buildDsn(baseUrl: string, publicKey: string, projectId: number): string {
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${publicKey}@${u.host}${prefix}/${projectId}`;
}

function newKey(): string {
  return randomBytes(16).toString('hex');
}

function toView(row: ProjectRow): ErrorProjectView {
  let key = '';
  try {
    key = decryptSecret(row.keyEnc);
  } catch {
    key = '';
  }
  return {
    stack: row.stack,
    projectId: row.projectId,
    dsn: key ? buildDsn(controllerPublicUrl(), key, row.projectId) : '',
    rateLimitPerMinute: row.rateLimitPerMinute,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  };
}

export async function getProject(ctx: OrgContext, stack: string): Promise<ErrorProjectView | null> {
  const row = await ctx.db.errorProject.findUnique({ where: { orgId_stack: { orgId: ctx.activeOrgId, stack } } });
  return row ? toView(row) : null;
}

export async function listProjects(ctx: OrgContext): Promise<ErrorProjectView[]> {
  const rows = await ctx.db.errorProject.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { stack: 'asc' } });
  return rows.map(toView);
}

/** The project's plaintext DSN, or null (deploy-path injection). */
export async function projectDsn(ctx: OrgContext, stack: string): Promise<string | null> {
  return (await getProject(ctx, stack))?.dsn || null;
}

/**
 * Get-or-create the stack's project. Project ids are random 7–9 digit
 * numbers (unguessable enough to not enumerate, numeric as SDKs require);
 * a collision on the unique index just retries.
 */
export async function ensureProject(ctx: OrgContext, stack: string): Promise<ErrorProjectView> {
  const existing = await ctx.db.errorProject.findUnique({ where: { orgId_stack: { orgId: ctx.activeOrgId, stack } } });
  if (existing) return toView(existing);
  const key = newKey();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await ctx.db.errorProject.create({
        data: {
          orgId: ctx.activeOrgId,
          stack,
          projectId: randomInt(1_000_000, 2_000_000_000),
          keyHash: hashToken(key),
          keyEnc: encryptSecret(key),
          rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
        },
      });
      await writeAudit(ctx, {
        action: 'errors.project.create',
        targetType: 'stack',
        targetId: stack,
        metadata: { projectId: row.projectId },
      });
      return toView(row);
    } catch (e) {
      // A concurrent create for the same stack won — return it.
      const raced = await ctx.db.errorProject.findUnique({ where: { orgId_stack: { orgId: ctx.activeOrgId, stack } } });
      if (raced) return toView(raced);
      if (attempt === 4) throw e;
    }
  }
  throw new Error('unreachable');
}

/** Rotate the DSN key. Old DSNs stop working immediately (clients need a redeploy). */
export async function rotateKey(ctx: OrgContext, stack: string): Promise<ErrorProjectView> {
  const existing = await ctx.db.errorProject.findUnique({ where: { orgId_stack: { orgId: ctx.activeOrgId, stack } } });
  if (!existing) return ensureProject(ctx, stack);
  const key = newKey();
  const row = await ctx.db.errorProject.update({
    where: { id: existing.id },
    data: { keyHash: hashToken(key), keyEnc: encryptSecret(key), rotatedAt: new Date() },
  });
  invalidateProjectCache(row.projectId);
  await writeAudit(ctx, { action: 'errors.project.rotateKey', targetType: 'stack', targetId: stack, metadata: { projectId: row.projectId } });
  return toView(row);
}

export async function setRateLimit(ctx: OrgContext, stack: string, perMinute: number): Promise<ErrorProjectView> {
  const project = await ensureProject(ctx, stack);
  const row = await ctx.db.errorProject.update({
    where: { projectId: project.projectId },
    data: { rateLimitPerMinute: perMinute },
  });
  invalidateProjectCache(row.projectId);
  await writeAudit(ctx, { action: 'errors.project.setRateLimit', targetType: 'stack', targetId: stack, metadata: { perMinute } });
  return toView(row);
}

/* ----------------------------------------------------------------------------
 * Ingest-side lookup + rate limit (hot path; cached)
 * ------------------------------------------------------------------------- */

export interface IngestProject {
  orgId: string;
  stack: string;
  projectId: number;
  keyHash: string;
  rateLimitPerMinute: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<number, { at: number; project: IngestProject | null }>();

export function invalidateProjectCache(projectId?: number): void {
  if (projectId === undefined) cache.clear();
  else cache.delete(projectId);
}

/** Project by numeric id (cached 30 s, negative results too). */
export async function lookupIngestProject(db: DB, projectId: number): Promise<IngestProject | null> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.project;
  const row = await db.errorProject.findUnique({
    where: { projectId },
    select: { orgId: true, stack: true, projectId: true, keyHash: true, rateLimitPerMinute: true },
  });
  const project = row ?? null;
  cache.set(projectId, { at: Date.now(), project });
  if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
  return project;
}

/** Constant-time compare of a presented public key against the stored hash. */
export function keyMatches(project: IngestProject, presentedKey: string): boolean {
  const a = Buffer.from(hashToken(presentedKey));
  const b = Buffer.from(project.keyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Fixed one-minute windows per project. Returns 0 when the event may pass,
 * else the seconds until the window resets (the 429's Retry-After).
 */
const windows = new Map<number, { start: number; count: number }>();

export function takeRateLimit(projectId: number, perMinute: number, now = Date.now(), cost = 1): number {
  const w = windows.get(projectId);
  if (!w || now - w.start >= 60_000) {
    windows.set(projectId, { start: now, count: cost });
    return cost > perMinute ? 60 : 0;
  }
  if (w.count + cost > perMinute) return Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
  w.count += cost;
  return 0;
}

/** Test hook. */
export function resetRateLimits(): void {
  windows.clear();
}
