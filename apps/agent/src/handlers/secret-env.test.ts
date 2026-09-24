import { describe, expect, it } from 'bun:test';
import { SECRET_ENV_SHIM_CONFIG, SECRET_ENV_SHIM_PATH, SECRET_ENV_SHIM_SCRIPT } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { prepareSecretEnv, type SecretEnvDocker } from './secret-env';

function fake(opts: { configs?: string[]; raceOnCreate?: boolean } = {}) {
  const configs = new Set(opts.configs ?? []);
  const calls = { created: [] as { name: string; data: string }[], argv: [] as { image: string; pull?: boolean }[] };
  const docker: SecretEnvDocker = {
    listConfigs: async () => [...configs].map((name) => ({ name })),
    createConfig: async (name, dataB64) => {
      if (opts.raceOnCreate) {
        configs.add(name);
        throw new Error('config already exists');
      }
      calls.created.push({ name, data: Buffer.from(dataB64, 'base64').toString('utf8') });
      configs.add(name);
      return 'cfg1';
    },
    imageArgv: async (image, o) => {
      calls.argv.push({ image, pull: o?.pull });
      return { entrypoint: ['/entry'], cmd: ['serve'] };
    },
  };
  return { docker, calls };
}

const spec: ServiceSpec = {
  name: 'shop_web',
  image: 'web:1',
  env: { LOG: 'info' },
  secrets: [{ source: 'shop_web_API_KEY_v1', target: 'API_KEY' }],
  secretEnv: ['API_KEY'],
};

describe('prepareSecretEnv (agent deploy-time wrap)', () => {
  it('creates the shim config once, resolves the image argv, wraps the spec', async () => {
    const { docker, calls } = fake();
    const out = await prepareSecretEnv(docker, spec, { pull: true });
    expect(calls.created).toEqual([{ name: SECRET_ENV_SHIM_CONFIG, data: SECRET_ENV_SHIM_SCRIPT }]);
    expect(calls.argv).toEqual([{ image: 'web:1', pull: true }]);
    expect(out.command).toEqual(['/bin/sh', SECRET_ENV_SHIM_PATH]);
    expect(out.args).toEqual(['/entry', 'serve']);
    expect(out.env).toEqual({ LOG: 'info', SWARMY_SECRET_ENV: 'API_KEY' });
    expect(out.secretEnv).toBeUndefined();

    await prepareSecretEnv(docker, spec);
    expect(calls.created).toHaveLength(1); // idempotent
  });

  it('an explicit command wraps that command (not the image entrypoint)', async () => {
    const { docker } = fake({ configs: [SECRET_ENV_SHIM_CONFIG] });
    const out = await prepareSecretEnv(docker, { ...spec, command: ['/app'] });
    expect(out.args).toEqual(['/app']);
  });

  it('refuses a shell-less image with the fix instead of deploying tasks that cannot start', async () => {
    const { docker } = fake({ configs: [SECRET_ENV_SHIM_CONFIG] });
    const noSh = { ...docker, imageHasShell: async () => false };
    await expect(prepareSecretEnv(noSh, spec)).rejects.toThrow(/no \/bin\/sh.*API_KEY to file delivery/);
  });

  it('tolerates another manager creating the shim first', async () => {
    const { docker } = fake({ raceOnCreate: true });
    await expect(prepareSecretEnv(docker, spec)).resolves.toBeDefined();
  });

  it('no secretEnv → no Docker calls, spec passes through', async () => {
    const { docker, calls } = fake();
    const { secretEnv: _s, ...plain } = spec;
    expect(await prepareSecretEnv(docker, plain)).toEqual(plain);
    expect(calls.created).toHaveLength(0);
    expect(calls.argv).toHaveLength(0);
  });
});
