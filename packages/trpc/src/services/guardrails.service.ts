import type { OrgContext } from '../context';

/**
 * Guardrails — production safety rules enforced at deploy admission (slice E4).
 *
 * Spine stub — slice E4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice E4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
