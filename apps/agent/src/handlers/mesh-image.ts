/**
 * Which mesh client image to run (M3 client mirror). The controller may send a
 * `mirrorImage` hint: the cluster's own copy of the pinned upstream client
 * image in the built-in registry (`@swarmy/core/protocol` `MeshImageHint`).
 *
 *  - No hint: exactly the old behaviour (pull upstream, a failed pull is not
 *    fatal: a copy already on the node still runs).
 *  - A hint and the pinned upstream already on the node: run it, no network
 *    at all (a digest ref is immutable bytes). This matters most when the mesh
 *    is what's broken, because the registry rides the swarm over the mesh.
 *  - Otherwise: pull the cluster copy, falling back to upstream on failure.
 */
import { authForImage, pullWithFallback } from './pull-fallback';

export interface MeshImageHint {
  mirrorImage?: string;
  registryAuth?: { username: string; password: string; server?: string };
}

type Docker = Parameters<typeof pullWithFallback>[0];

/** A `…@sha256:<64 hex>` reference (immutable). */
export function isDigestPinned(ref: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(ref);
}

export async function resolveMeshClientImage(docker: Docker, upstream: string, hint?: MeshImageHint): Promise<string> {
  const mirror = hint?.mirrorImage;
  if (!mirror || mirror === upstream) {
    await docker.pullImage(upstream).catch(() => undefined);
    return upstream;
  }
  const present = await docker.docker
    .getImage(upstream)
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (present && isDigestPinned(upstream)) return upstream;
  const auth = hint?.registryAuth ? authForImage(mirror, hint.registryAuth) : undefined;
  return pullWithFallback(docker, mirror, upstream, auth);
}
