import type { OrgContext } from '../context';

/**
 * Alerting — notification channels, alert rules, firing/resolved event feed (slice C3).
 *
 * Spine stub — slice C3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice C3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
