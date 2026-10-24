/**
 * Which mesh client image to run (M3 client mirror). The controller may send a
 * `mirrorImage` hint: the cluster's own copy of the pinned upstream client
 * image in the built-in registry (`@swarmy/core/protocol` `MeshImageHint`).
 *
 *  - The pinned upstream already on the node: run it, no network at all (a
 *    digest ref is immutable bytes). This matters most when the mesh is what's
 *    broken, because the registry rides the swarm over the mesh.
 *  - No hint (a new node's first, mesh-first join: no swarm yet, so no
 *    registry forwarder): the controller's copy when it serves one
 *    (`fromController`, ./controller-image.ts, verified against the pin),
 *    else pull upstream (a failed pull is not fatal: a copy already on the
 *    node still runs).
 *  - A hint: pull the cluster copy, falling back to upstream on failure.
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

export async function resolveMeshClientImage(
  docker: Docker,
  upstream: string,
  hint?: MeshImageHint,
  /** Load `ref` from the controller → the image id to run, or null. */
  fromController?: (ref: string) => Promise<string | null>,
): Promise<string> {
  const present = () =>
    docker.docker
      .getImage(upstream)
      .inspect()
      .then(() => true)
      .catch(() => false);
  const mirror = hint?.mirrorImage;
  if (!mirror || mirror === upstream) {
    if (fromController && isDigestPinned(upstream)) {
      if (await present()) return upstream;
      const loaded = await fromController(upstream).catch(() => null);
      if (loaded) return loaded;
    }
    await docker.pullImage(upstream).catch(() => undefined);
    return upstream;
  }
  if (isDigestPinned(upstream) && (await present())) return upstream;
  const auth = hint?.registryAuth ? authForImage(mirror, hint.registryAuth) : undefined;
  return pullWithFallback(docker, mirror, upstream, auth);
}
