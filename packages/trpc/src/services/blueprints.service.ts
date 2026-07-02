import type { OrgContext } from '../context';

/**
 * Blueprints — parameterized app catalog: list, plan (dry-run), deploy (slice F3).
 *
 * Spine stub — slice F3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
