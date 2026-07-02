import type { OrgContext } from '../context';

/**
 * Exposure — public/private/protected audit of every service + exposure rules (slice E3).
 *
 * Spine stub — slice E3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice E3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
