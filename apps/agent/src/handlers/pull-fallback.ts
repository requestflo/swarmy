/**
 * Pull an image, falling back to an upstream ref (self-reliance B3/B4).
 *
 * The controller rewrites swarmy's system images to their mirrored copies in
 * the in-swarm registry (`localhost:5000/swarmy-system/…@sha256:…`). If that
 * registry is unreachable (task rescheduling, volume lost) the node must still
 * work, so: pull `preferred` (with its login); if that fails and it isn't
 * already on the node, pull and use `fallback` instead. Returns the ref to run.
 */
import type { DockerClient } from '@swarmy/core/docker';

export interface PullAuth {
  username: string;
  password: string;
  server?: string;
}

export async function pullWithFallback(
  docker: Pick<DockerClient, 'pullImage'> & { docker: { getImage(ref: string): { inspect(): Promise<unknown> } } },
  preferred: string,
  fallback: string | undefined,
  auth?: PullAuth,
): Promise<string> {
  const authconfig = auth ? { username: auth.username, password: auth.password, serveraddress: auth.server } : undefined;
  try {
    await docker.pullImage(preferred, authconfig);
    return preferred;
  } catch {
    const present = await docker.docker
      .getImage(preferred)
      .inspect()
      .then(() => true)
      .catch(() => false);
    if (present || !fallback || fallback === preferred) return preferred;
    await docker.pullImage(fallback).catch(() => undefined);
    return fallback;
  }
}

/**
 * No-pull variant (a pre-staged image): run `preferred` when it is on the node,
 * else `fallback` when THAT is, else `preferred` (Docker reports the miss).
 */
export async function presentOrFallback(
  docker: { docker: { getImage(ref: string): { inspect(): Promise<unknown> } } },
  preferred: string,
  fallback: string | undefined,
): Promise<string> {
  const has = (ref: string) =>
    docker.docker
      .getImage(ref)
      .inspect()
      .then(() => true)
      .catch(() => false);
  if (!fallback || fallback === preferred || (await has(preferred))) return preferred;
  return (await has(fallback)) ? fallback : preferred;
}

/** The login to use for `image`, when `auth.server` is its registry host. */
export function authForImage(image: string, auth: PullAuth | undefined): PullAuth | undefined {
  if (!auth) return undefined;
  const host = image.split('/')[0] ?? '';
  return !auth.server || auth.server === host ? auth : undefined;
}
