import type { OrgContext } from '../context';

/**
 * Cost — node cost labels, utilization, per-stack share, recommendations (slice F1).
 *
 * Spine stub — slice F1 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F1. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
