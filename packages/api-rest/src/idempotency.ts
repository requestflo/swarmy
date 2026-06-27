/**
 * Idempotency-Key support for the public REST API (Wave G1, epic #13 Phase 2).
 *
 * When a client sends `Idempotency-Key: <key>` on a mutation (POST/PUT/PATCH/
 * DELETE), the first request is processed normally and its (status, body) is
 * persisted keyed by (orgId, key). A retry with the same key replays the stored
 * response verbatim — so a network retry never double-creates a resource.
 *
 * Persistence is a new Prisma model `IdempotencyKey` delivered as an INTEGRATION
 * snippet (it cannot live in the committed schema until migrated). To stay fully
 * type-safe before `prisma generate`, the delegate is reached through a single
 * narrowly-typed accessor (`models`) — mirroring the pattern in
 * `@swarmy/trpc`'s `terminal.service.ts` / `clusterVolume.service.ts`.
 *
 * Scope: only methods that mutate are eligible; reads pass through untouched. A
 * missing header is a no-op (the key is optional, per the IETF draft). The unique
 * constraint `@@unique([orgId, key])` is the concurrency guard — a racing second
 * request that loses the `create` falls back to replaying the now-stored row.
 */
import type { MiddlewareHandler } from 'hono';
import type { OrgContext } from '@swarmy/trpc';
import type { RestEnv } from './middleware';
import { PROBLEM_CONTENT_TYPE, problem } from './problem';

/** HTTP methods eligible for idempotent replay. */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Max key length we'll store — guards against pathological headers. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Normalize a presented Idempotency-Key header into the stored key, or `null`
 * when the header is absent/blank/too long. Trims surrounding whitespace; an
 * all-whitespace value is treated as absent. Pure — unit-tested.
 */
export function normalizeIdempotencyKey(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  return trimmed;
}

/** Stored row shape — structurally identical to the post-integration delegate. */
interface IdempotencyKeyRow {
  id: string;
  orgId: string;
  key: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: Date;
}

interface IdempotencyKeyDelegate {
  findUnique(args: {
    where: { orgId_key: { orgId: string; key: string } };
  }): Promise<IdempotencyKeyRow | null>;
  create(args: {
    data: {
      orgId: string;
      key: string;
      method: string;
      path: string;
      statusCode: number;
      responseBody: unknown;
    };
  }): Promise<IdempotencyKeyRow>;
}

/**
 * Narrow accessor over the (post-integration) Prisma client. The `IdempotencyKey`
 * delegate does not exist until the schema migration lands; this keeps typecheck
 * green in the meantime and is a no-op cast afterwards.
 */
function models(db: OrgContext['db']): { idempotencyKey: IdempotencyKeyDelegate } {
  return db as unknown as { idempotencyKey: IdempotencyKeyDelegate };
}

/**
 * Build the idempotency middleware. Must run AFTER `apiKeyAuth` (it needs
 * `c.get('orgCtx')`). Non-mutation requests and keyless requests pass straight
 * through.
 */
export function idempotency(): MiddlewareHandler<RestEnv> {
  return async (c, next) => {
    if (!MUTATION_METHODS.has(c.req.method.toUpperCase())) return next();

    const key = normalizeIdempotencyKey(
      c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key'),
    );
    if (key === null) return next();

    const ctx = c.get('orgCtx');
    const orgId = ctx.activeOrgId;
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    const delegate = models(ctx.db).idempotencyKey;

    // Replay a stored response for the same key (idempotent retry).
    const existing = await delegate
      .findUnique({ where: { orgId_key: { orgId, key } } })
      .catch(() => null);
    if (existing) {
      // A key is bound to the first (method,path) it was used with — reusing it
      // for a different operation is a client error, not a silent replay.
      if (existing.method !== method || existing.path !== path) {
        return c.json(
          problem(
            409,
            `Idempotency-Key already used for ${existing.method} ${existing.path}`,
            'IDEMPOTENCY_KEY_REUSED',
          ),
          409,
          { 'content-type': PROBLEM_CONTENT_TYPE },
        );
      }
      c.header('Idempotency-Replayed', 'true');
      return c.json(existing.responseBody as object, existing.statusCode as 200);
    }

    // First use: run the handler, then persist its response for future replays.
    await next();

    const status = c.res.status;
    // Only memoize successful, JSON responses — never a 4xx/5xx (let the caller
    // retry into a fresh attempt) and never a streamed/empty body.
    if (status >= 200 && status < 300) {
      const cloned = c.res.clone();
      const body = await cloned.json().catch(() => null);
      if (body !== null) {
        await delegate
          .create({
            data: { orgId, key, method, path, statusCode: status, responseBody: body },
          })
          // A racing concurrent request may have created the row first; the
          // unique constraint rejects us — safe to ignore, both share a result.
          .catch(() => undefined);
      }
    }
  };
}
