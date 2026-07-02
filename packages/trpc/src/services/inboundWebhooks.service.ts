import type { OrgContext } from '../context';

/**
 * Inbound webhook gateway — public endpoints, verified deliveries, retry/replay/DLQ (slice B4).
 *
 * Spine stub — slice B4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice B4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
