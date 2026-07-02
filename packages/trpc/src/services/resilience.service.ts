import type { OrgContext } from '../context';

/**
 * Resilience — posture checks, score, safe failover/restore drills (slice F2).
 *
 * Spine stub — slice F2 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F2. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
