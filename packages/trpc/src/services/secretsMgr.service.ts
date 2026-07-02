import type { OrgContext } from '../context';

/**
 * Secrets manager — Docker secret families, versions, rotation, usage map (slice E1).
 *
 * Spine stub — slice E1 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice E1. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
