import type { OrgContext } from '../context';

/**
 * Configs manager — Docker config families, edit/apply/rollback, restart preview (slice E2).
 *
 * Spine stub — slice E2 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice E2. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
