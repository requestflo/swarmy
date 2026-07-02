import type { OrgContext } from '../context';

/**
 * Notifications — email provider config, templates, delivery log, test send (slice F6).
 *
 * Spine stub — slice F6 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F6. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
