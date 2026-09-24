/**
 * Deploy pre-pull. A deploy that must read the image itself (the secret-env
 * shim needs its ENTRYPOINT/CMD and a /bin/sh probe) pulls it on the manager
 * BEFORE touching the service. A multi-GB image on a small node outlives the
 * deploy's 120s budget, so the pull is its own phase: it streams throttled
 * `progress` frames the hub treats as heartbeats (re-arming the deadline) and
 * shows on the dashboard as "pulling image…". Plain deploys never pull here —
 * the swarm pulls on the task's node.
 */
import type { CommandProgress, ServiceSpec } from '@swarmy/core/protocol';

export interface DeployPullDocker {
  pullImage(
    image: string,
    authconfig?: { username: string; password: string; serveraddress?: string },
    onProgress?: (line: string) => void,
  ): Promise<string>;
  imagePresent(image: string): Promise<boolean>;
}

/** Only the secret-env path reads the image on the manager. */
export function deployNeedsLocalImage(spec: Pick<ServiceSpec, 'secretEnv'>): boolean {
  return !!spec.secretEnv?.length;
}

/**
 * Pull `spec.image` when the deploy needs it locally and the policy says so
 * (`always`, or `missing` / unset when it's absent). Returns whether it pulled.
 * `never` leaves a missing image to fail in the inspect that follows.
 */
export async function prePullForDeploy(
  docker: DeployPullDocker,
  spec: Pick<ServiceSpec, 'image' | 'secretEnv'>,
  opts: {
    pullPolicy?: 'always' | 'missing' | 'never';
    authconfig?: { username: string; password: string; serveraddress?: string };
    onProgress?: (p: CommandProgress) => void;
    /** Min ms between progress frames (heartbeats), default 5s. */
    throttleMs?: number;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (!deployNeedsLocalImage(spec) || opts.pullPolicy === 'never') return false;
  if (opts.pullPolicy !== 'always' && (await docker.imagePresent(spec.image))) return false;
  const now = opts.now ?? Date.now;
  const throttle = opts.throttleMs ?? 5_000;
  const report = (status?: string) =>
    opts.onProgress?.({
      phase: 'pulling',
      message: (status ? `pulling image ${spec.image}: ${status}` : `pulling image ${spec.image}…`).slice(0, 500),
    });
  report();
  let last = now();
  await docker.pullImage(spec.image, opts.authconfig, (line) => {
    const t = now();
    if (t - last < throttle) return;
    last = t;
    report(line);
  });
  return true;
}
