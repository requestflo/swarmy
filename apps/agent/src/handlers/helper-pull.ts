/**
 * The image a backup/restore/dump sidecar runs, pulled the way a
 * `container.runOnce` pulls a mirrored system image (`pull-fallback.ts`).
 *
 * On a cluster with a trusted mirror the controller sends each helper as its
 * in-cluster copy, the upstream ref it replaced as the fallback, and the
 * registry login (`@swarmy/core/protocol` `helper-pull.ts`). So: pull the
 * copy with the login; when that fails and the copy isn't on the node, pull
 * and run the upstream ref instead. Returns the ref to run.
 *
 * An older controller sends no fallback and no login: then nothing is pulled
 * here, and the sidecar pulls the image itself as before (`runSidecar`).
 */
import { helperImage, type HelperImage, type RegistryAuth } from '@swarmy/core/protocol';
import { authForImage, pullWithFallback } from './pull-fallback';

type PullDocker = Parameters<typeof pullWithFallback>[0];

export async function pullHelper(
  docker: PullDocker,
  kind: HelperImage,
  sent: string | undefined,
  fallback: string | undefined,
  auth: RegistryAuth | undefined,
): Promise<string> {
  const image = helperImage(kind, sent);
  if (!fallback && !auth) return image;
  const upstream = fallback ? helperImage(kind, fallback) : undefined;
  return pullWithFallback(docker, image, upstream, authForImage(image, auth));
}

/** Is `image` digest-pinned and already on the node? (Its bytes can't change, so no re-pull.) */
export async function pinnedOnNode(docker: { docker: { getImage(ref: string): { inspect(): Promise<unknown> } } }, image: string): Promise<boolean> {
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) return false;
  try {
    await docker.docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}
