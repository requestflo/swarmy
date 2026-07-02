import type { OrgContext } from '../context';

/**
 * Incidents — open/resolve lifecycle, event timeline, post-mortem notes (slice C4).
 *
 * Spine stub — slice C4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice C4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
