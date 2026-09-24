import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { deployOrUpdate } from './executor';

const OUT_OF_SEQ = 'rpc error: code = Unknown desc = update out of sequence';

/** A DockerClient double whose live version moves under a concurrent writer. */
function racingDocker(failures: number, err = OUT_OF_SEQ) {
  let version = 7;
  const seen: number[] = [];
  const svc = { inspect: async () => ({ ID: 'svc1', Version: { Index: version } }) };
  const docker = {
    getServiceByName: async () => svc,
    prepareServiceOptions: async () => ({ Name: 'shop_web' }),
    updateServiceWithAuth: async (_s: unknown, body: { version: number }) => {
      seen.push(body.version);
      if (seen.length <= failures) {
        version++; // the other deploy won
        throw new Error(err);
      }
    },
  } as unknown as DockerClient;
  return { docker, seen };
}

const spec = { name: 'shop_web', image: 'nginx:1' };

describe('deployOrUpdate under concurrent deploys (QA-006)', () => {
  it('re-reads the version and re-applies after "update out of sequence"', async () => {
    const { docker, seen } = racingDocker(2);
    expect(await deployOrUpdate(docker, spec)).toEqual({ serviceId: 'svc1', created: false });
    expect(seen).toEqual([7, 8, 9]); // each retry used the freshly read version
  });

  it('gives up after a bounded number of attempts', async () => {
    const { docker, seen } = racingDocker(100);
    await expect(deployOrUpdate(docker, spec)).rejects.toThrow('update out of sequence');
    expect(seen.length).toBe(6);
  });

  it('never retries a real error', async () => {
    const { docker, seen } = racingDocker(1, 'invalid mount config');
    await expect(deployOrUpdate(docker, spec)).rejects.toThrow('invalid mount config');
    expect(seen.length).toBe(1);
  });

  it('a create that loses the race to a concurrent create becomes an update', async () => {
    let created = false;
    const svc = { inspect: async () => ({ ID: 'svc9', Version: { Index: 1 } }) };
    const docker = {
      getServiceByName: async () => (created ? svc : null),
      createService: async () => {
        created = true;
        throw new Error('rpc error: code = AlreadyExists desc = name conflicts with an existing object');
      },
      prepareServiceOptions: async () => ({}),
      updateServiceWithAuth: async () => undefined,
    } as unknown as DockerClient;
    expect(await deployOrUpdate(docker, spec)).toEqual({ serviceId: 'svc9', created: false });
  });
});
