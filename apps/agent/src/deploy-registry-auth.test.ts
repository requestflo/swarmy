import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { deployOrUpdate } from './executor';

/** A DockerClient double that records which auth each deploy path received. */
function fakeDocker(existing: boolean) {
  const calls: { create?: unknown; update?: unknown; updateCalled: boolean } = { updateCalled: false };
  const svc = { inspect: async () => ({ ID: 'svc1', Version: { Index: 7 } }) };
  const docker = {
    getServiceByName: async () => (existing ? svc : null),
    createService: async (_spec: unknown, auth?: unknown) => {
      calls.create = auth;
      return 'svc-new';
    },
    prepareServiceOptions: async () => ({ Name: 'web' }),
    updateServiceWithAuth: async (_s: unknown, _body: unknown, auth?: unknown) => {
      calls.updateCalled = true;
      calls.update = auth;
    },
  } as unknown as DockerClient;
  return { docker, calls };
}

const spec = { name: 'web', image: 'localhost:5000/web@sha256:' + 'b'.repeat(64) };
const auth = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };

describe('deployOrUpdate registry auth', () => {
  it('create: passes creds as the dockerode authconfig (X-Registry-Auth)', async () => {
    const { docker, calls } = fakeDocker(false);
    await deployOrUpdate(docker, spec, auth);
    expect(calls.create).toEqual({ username: 'swarmy', password: 'pw', serveraddress: 'localhost:5000' });
  });

  it('update: re-stamps the creds on the existing service', async () => {
    const { docker, calls } = fakeDocker(true);
    const r = await deployOrUpdate(docker, spec, auth);
    expect(r).toEqual({ serviceId: 'svc1', created: false });
    expect(calls.update).toEqual({ username: 'swarmy', password: 'pw', serveraddress: 'localhost:5000' });
  });

  it('no creds → no authconfig (public images unchanged)', async () => {
    const { docker, calls } = fakeDocker(true);
    await deployOrUpdate(docker, spec);
    expect(calls.updateCalled).toBe(true);
    expect(calls.update).toBeUndefined();
  });
});
