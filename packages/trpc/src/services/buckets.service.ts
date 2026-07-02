import type { OrgContext } from '../context';

/**
 * Object storage buckets — Garage bucket/key CRUD, quotas, usage, service attach (slice A4).
 *
 * Spine stub — slice A4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice A4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
