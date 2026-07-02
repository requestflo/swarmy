import type { OrgContext } from '../context';

/**
 * Vector store — Qdrant / pgvector, Docker-truth via `swarmy.vector.*` labels (slice F5).
 *
 * Spine stub — slice F5 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice F5. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
