import type { OrgContext } from '../context';

/**
 * Queues — queue defs in the `swarmy.queues` JSON label, depth stats, scaling, DLQ actions (slice B1).
 *
 * Spine stub — slice B1 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice B1. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
