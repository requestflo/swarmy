import type { OrgContext } from '../context';

/**
 * Workflow engine — versioned step definitions, sequential runs, approvals (slice B3).
 *
 * Spine stub — slice B3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice B3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
