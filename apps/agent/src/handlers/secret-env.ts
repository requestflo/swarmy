/**
 * Secret-env shim at deploy time: a spec carrying `secretEnv` (secret app
 * variables delivered as ENV) is rewritten to run `/bin/sh <shim> <original
 * argv…>` with the shim config mounted — see `wrapSecretEnv` in
 * `@swarmy/core` (app-secrets). The VALUES never pass through here: they are
 * Docker secrets the swarm mounts on the task's tmpfs; this only needs the
 * image's ENTRYPOINT/CMD (when the spec has no explicit command) and the
 * shim config to exist.
 */
import {
  applySecretEnvFileFallback,
  needsImageArgv,
  unwrapSecretEnv,
  SECRET_ENV_SHIM_CONFIG,
  SECRET_ENV_SHIM_SCRIPT,
  wrapSecretEnv,
  type ImageArgv,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';

export interface SecretEnvDocker {
  listConfigs(): Promise<Array<{ name: string }>>;
  createConfig(name: string, dataB64: string, labels?: Record<string, string>): Promise<string>;
  imageArgv(
    image: string,
    opts?: { pull?: boolean; authconfig?: { username: string; password: string; serveraddress?: string } },
  ): Promise<ImageArgv>;
  imageHasShell?(image: string): Promise<boolean>;
  /** The local image id (`sha256:…`) — the shell-probe cache key. */
  imageId?(image: string): Promise<string | undefined>;
}

/** image id (digest) → has /bin/sh. An image id is immutable, so the answer never changes. */
const shellCache = new Map<string, boolean>();

/** Does `image` have /bin/sh? Probed once per image digest (create-without-start + stat). */
export async function hasShellCached(docker: SecretEnvDocker, image: string): Promise<boolean> {
  if (!docker.imageHasShell) return true; // no probe available: assume the shim can run
  const id = (await docker.imageId?.(image).catch(() => undefined)) ?? undefined;
  const cached = id ? shellCache.get(id) : undefined;
  if (cached !== undefined) return cached;
  const has = await docker.imageHasShell(image);
  if (id) shellCache.set(id, has);
  return has;
}

/** Test seam. */
export function clearShellCache(): void {
  shellCache.clear();
}

/** Idempotently create the (immutable, value-free) shim config. */
export async function ensureSecretEnvShim(docker: SecretEnvDocker): Promise<void> {
  const has = async () => (await docker.listConfigs()).some((c) => c.name === SECRET_ENV_SHIM_CONFIG);
  if (await has()) return;
  try {
    await docker.createConfig(
      SECRET_ENV_SHIM_CONFIG,
      Buffer.from(SECRET_ENV_SHIM_SCRIPT, 'utf8').toString('base64'),
      { 'swarmy.managed': 'true', 'swarmy.secretenv.shim': 'v1' },
    );
  } catch (e) {
    // Another manager raced us to it — fine; anything else is a real failure.
    if (!(await has())) throw e;
  }
}

/**
 * Resolve + wrap. Returns the spec unchanged (minus the `secretEnv` field)
 * when nothing asks for env delivery.
 */
export async function prepareSecretEnv(
  docker: SecretEnvDocker,
  spec: ServiceSpec,
  opts: { pull?: boolean; authconfig?: { username: string; password: string; serveraddress?: string } } = {},
): Promise<ServiceSpec> {
  // A live spec that fell back earlier is re-decided from scratch.
  const wanted = unwrapSecretEnv(spec);
  if (!wanted.secretEnv?.length) return wrapSecretEnv(wanted, null);
  // Always resolve the image (pulls it when absent) — also needed for the shell probe.
  const argv = await docker.imageArgv(wanted.image, opts);
  if (!(await hasShellCached(docker, wanted.image))) {
    // No /bin/sh for the shim (FROM scratch / distroless). Names the spec
    // allows fall back to `<NAME>_FILE` (the secret file is already mounted)
    // — never to a plain value. Anything else fails the deploy with the fix,
    // instead of rolling out tasks that die on "exec /bin/sh: no such file".
    const { spec: filed, unresolved } = applySecretEnvFileFallback(wanted);
    if (unresolved.length > 0) {
      throw new Error(
        `${wanted.image} has no /bin/sh, so secrets can't be delivered as env vars — switch ${unresolved.join(', ')} to file delivery (<NAME>_FILE=/run/secrets/<NAME>)`,
      );
    }
    return filed;
  }
  await ensureSecretEnvShim(docker);
  return wrapSecretEnv(wanted, needsImageArgv(wanted) ? argv : null);
}
