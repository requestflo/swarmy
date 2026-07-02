import type { OrgContext } from '../context';

/**
 * PR preview environments — `swarmy.preview.*` stacks with TTL + teardown (slice D4).
 *
 * Spine stub — slice D4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice D4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
