import type { OrgContext } from '../context';

/**
 * Managed search — Meilisearch/Typesense, Docker-truth via `swarmy.search.*` labels (slice F4).
 *
 * Spine stub — slice F4 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F4. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
