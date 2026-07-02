import type { OrgContext } from '../context';

/**
 * Audit pack — audit log querying, canned questions, export, retention (slice E5).
 *
 * Spine stub — slice E5 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice E5. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
