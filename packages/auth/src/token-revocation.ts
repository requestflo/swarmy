import type { DB } from '@swarmy/db';

/**
 * Sign-out and session revocation reach swarmy's stateless credentials too.
 *
 * Better Auth's OAuth provider issues JWT access tokens for swarmy's own APIs
 * (MCP, REST) that verify by signature alone, and refresh tokens that keep
 * minting them for 30 days, with no check that the browser session they came
 * from still exists. So ending a session (sign-out, "sign out everywhere", a
 * 2FA reset) does three things here:
 *
 *  1. stamps `User.tokensRevokedAt`; the API token verifier refuses every JWT
 *     whose `iat` is at or before it, so outstanding access tokens die at once;
 *  2. deletes the OAuth grants (refresh + opaque access tokens) minted from the
 *     ended session, or all of the user's grants for "sign out everywhere", so
 *     those clients cannot mint replacements. A client authorized from a
 *     session that is still live just refreshes;
 *  3. records an in-process marker that the forward-auth decision cache reads,
 *     so a cached app permit does not outlive the session either.
 *
 * Expiry clean-up (Better Auth deleting a session that already lapsed) is not
 * a revocation and changes nothing.
 */

export type RevocationDb = Pick<DB, 'user' | 'oidcAccessToken' | 'oidcRefreshToken'>;

/** Better Auth endpoints whose session deletions end every grant, not just that session's. */
const REVOKE_ALL_PATHS = new Set(['/revoke-sessions']);

export interface RevokeTokensOptions {
  /** Only the grants minted from this session. Omit to end all of the user's grants. */
  sessionId?: string;
  now?: Date;
}

export async function revokeUserTokens(db: RevocationDb, userId: string, opts: RevokeTokensOptions = {}): Promise<void> {
  const now = opts.now ?? new Date();
  noteSessionsRevoked(userId, now.getTime());
  await db.user.updateMany({ where: { id: userId }, data: { tokensRevokedAt: now } });
  const scope = opts.sessionId ? { userId, sessionId: opts.sessionId } : { userId };
  // Access rows first: they reference refresh rows.
  await db.oidcAccessToken.deleteMany({ where: scope });
  await db.oidcRefreshToken.deleteMany({ where: scope });
}

interface DeletedSession {
  id: string;
  userId: string;
  expiresAt: Date | string | number;
}

/** Better Auth `databaseHooks.session.delete.after`. */
export function onSessionDeleted(db: RevocationDb) {
  return async (session: DeletedSession, ctx?: { path?: string } | null): Promise<void> => {
    if (new Date(session.expiresAt).getTime() <= Date.now()) return;
    const all = Boolean(ctx?.path && REVOKE_ALL_PATHS.has(ctx.path));
    await revokeUserTokens(db, session.userId, all ? {} : { sessionId: session.id });
  };
}

/**
 * Whether a token issued at `iat` (JWT seconds) predates the user's
 * revocation stamp. A token minted in the same second as the stamp counts as
 * revoked: the client refreshes a second later. No `iat` with a stamp present
 * fails closed.
 */
export function isTokenRevoked(iat: unknown, revokedAt: Date | null | undefined): boolean {
  if (!revokedAt) return false;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return true;
  return iat * 1000 <= revokedAt.getTime();
}

// ── in-process marker (the forward-auth decision cache reads it) ───────────

const MARKER_KEEP_MS = 10 * 60_000;
const revokedAt = new Map<string, number>();

/** Record that some session of `userId` ended at `at` (ms). */
export function noteSessionsRevoked(userId: string, at = Date.now()): void {
  revokedAt.set(userId, Math.max(at, revokedAt.get(userId) ?? 0));
  if (revokedAt.size > 5000) {
    for (const [k, t] of revokedAt) if (t < at - MARKER_KEEP_MS) revokedAt.delete(k);
  }
}

/**
 * True when a session of `userId` ended at or after `since` (ms) in this
 * process. Only meant for caches younger than ten minutes; the CLI recovery
 * path runs in another process and is caught by the DB checks instead.
 */
export function sessionsRevokedSince(userId: string, since: number): boolean {
  const at = revokedAt.get(userId);
  return at !== undefined && at >= since;
}
