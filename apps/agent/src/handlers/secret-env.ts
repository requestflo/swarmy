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
  needsImageArgv,
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
  if (!spec.secretEnv?.length) return wrapSecretEnv(spec, null);
  await ensureSecretEnvShim(docker);
  // Always resolve the image (pulls it when absent) — also needed for the shell probe.
  const argv = await docker.imageArgv(spec.image, opts);
  if (docker.imageHasShell && !(await docker.imageHasShell(spec.image))) {
    // Fail the deploy with the fix, instead of rolling out tasks that die on
    // "exec /bin/sh: no such file" (FROM scratch / distroless images).
    throw new Error(
      `${spec.image} has no /bin/sh, so secrets can't be delivered as env vars — switch ${spec.secretEnv.join(', ')} to file delivery (<NAME>_FILE=/run/secrets/<NAME>)`,
    );
  }
  return wrapSecretEnv(spec, needsImageArgv(spec) ? argv : null);
}
