import type { OrgContext } from '../context';

/**
 * Managed cache — Valkey/Redis clusters, Docker-truth via `swarmy.cache.*` labels (mirrors manageddb) (slice A3).
 *
 * Spine stub — slice A3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice A3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
