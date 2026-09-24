import { describe, expect, test } from 'bun:test';
import { wrapSecretEnv } from '@swarmy/core';
import {
  REGISTRY_CACHE_AUTH_LABEL,
  REGISTRY_CACHE_SERVICE_NAME,
  cacheHubAuthOf,
  ensureCache,
  registryCacheConverged,
  registryCacheSecretName,
  registryCacheServiceSpec,
} from './system-images.service';

const auth = { username: 'acme', secret: registryCacheSecretName('acme', 'dckr_pat_x') };

describe('pull-through cache Docker Hub login', () => {
  test('anonymous spec: no creds, empty auth label', () => {
    const s = registryCacheServiceSpec('https://registry-1.docker.io');
    expect(s.env?.REGISTRY_PROXY_USERNAME).toBeUndefined();
    expect(s.secrets).toBeUndefined();
    expect(s.labels?.[REGISTRY_CACHE_AUTH_LABEL]).toBe('');
  });

  test('with a login: username in env, password only as a secret the shim exports', () => {
    const s = registryCacheServiceSpec('https://registry-1.docker.io', auth);
    expect(s.env?.REGISTRY_PROXY_USERNAME).toBe('acme');
    expect(JSON.stringify(s)).not.toContain('dckr_pat_x');
    expect(s.secrets).toEqual([{ source: auth.secret, target: 'REGISTRY_PROXY_PASSWORD', mode: 0o400 }]);
    expect(s.secretEnv).toEqual(['REGISTRY_PROXY_PASSWORD']);
    // The agent's shim accepts it (the secret is mounted at the env name).
    const wrapped = wrapSecretEnv(s as never, { entrypoint: ['/entrypoint.sh'], cmd: ['/etc/docker/registry/config.yml'] });
    expect(wrapped.env?.SWARMY_SECRET_ENV).toBe('REGISTRY_PROXY_PASSWORD');
    expect(s.labels?.[REGISTRY_CACHE_AUTH_LABEL]).toBe(`acme:${auth.secret}`);
  });

  test('secret names are content-addressed and never contain the password', () => {
    expect(registryCacheSecretName('acme', 'p')).toBe(registryCacheSecretName('acme', 'p'));
    expect(registryCacheSecretName('acme', 'p')).not.toBe(registryCacheSecretName('acme', 'q'));
    expect(registryCacheSecretName('acme', 'hunter2')).not.toContain('hunter2');
  });

  test('cacheHubAuthOf needs both halves', () => {
    expect(cacheHubAuthOf({ cacheUsername: 'a', cacheSecret: 's' })).toEqual({ username: 'a', secret: 's' });
    expect(cacheHubAuthOf({ cacheUsername: 'a', cacheSecret: null })).toBeNull();
    expect(cacheHubAuthOf(null)).toBeNull();
  });

  test('ensureCache redeploys only when the live login drifted', async () => {
    const deployed: unknown[] = [];
    const hubWith = (labels: Record<string, string> | null) => ({
      liveInventory: () => ({
        services: labels ? [{ name: REGISTRY_CACHE_SERVICE_NAME, labels } as never] : [],
        containers: [],
      }),
      dispatch: async (_n: string, _c: string, p: unknown) => {
        deployed.push(p);
        return {};
      },
    });
    expect(await ensureCache({ hub: hubWith(null) as never }, 'o', 'n', null)).toBe('deployed');
    expect(await ensureCache({ hub: hubWith({}) as never }, 'o', 'n', null)).toBe('noop'); // legacy anonymous cache
    expect(await ensureCache({ hub: hubWith({}) as never }, 'o', 'n', auth)).toBe('deployed');
    expect(
      await ensureCache({ hub: hubWith({ [REGISTRY_CACHE_AUTH_LABEL]: `acme:${auth.secret}` }) as never }, 'o', 'n', auth),
    ).toBe('noop');
    expect(registryCacheConverged(undefined, null)).toBe(false);
    expect(deployed).toHaveLength(2);
  });
});
