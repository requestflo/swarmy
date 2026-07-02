import type { OrgContext } from '../context';

/**
 * Releases & deploy safety — release history, health gates, rollback (slice D1).
 *
 * Spine stub — slice D1 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice D1. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
