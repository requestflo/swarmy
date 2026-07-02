import type { OrgContext } from '../context';

/**
 * Registry policy — image CVE scans (trivy), cosign signing, admission toggles (slice D3).
 *
 * Spine stub — slice D3 moves the real logic into this file. Only the
 * inert `overview` placeholder exists so the router mounts and the client
 * types compile before the slice lands.
 */

/** Inert placeholder result; replaced by slice D3. */
export async function overview(_ctx: OrgContext): Promise<{ ready: false }> {
  return { ready: false as const };
}
