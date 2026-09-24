import { describe, expect, test } from 'bun:test';
import type { CommandProgress } from '@swarmy/core/protocol';
import { prePullForDeploy, type DeployPullDocker } from './deploy-pull';

function fakeDocker(present: boolean, lines: string[] = []) {
  const pulls: string[] = [];
  const docker: DeployPullDocker = {
    imagePresent: async () => present,
    pullImage: async (image, _auth, onProgress) => {
      pulls.push(image);
      for (const l of lines) onProgress?.(l);
      return 'sha256:x';
    },
  };
  return { docker, pulls };
}

const secret = { image: 'big/app:1', secretEnv: ['DB_PASSWORD'] };

describe('prePullForDeploy', () => {
  test('a plain deploy never pulls on the manager (the swarm pulls on the task node)', async () => {
    const { docker, pulls } = fakeDocker(false);
    expect(await prePullForDeploy(docker, { image: 'x' }, { pullPolicy: 'always' })).toBe(false);
    expect(pulls).toEqual([]);
  });

  test('secret-env + image absent pulls, reporting a pulling phase first', async () => {
    const { docker, pulls } = fakeDocker(false);
    const seen: CommandProgress[] = [];
    expect(await prePullForDeploy(docker, secret, { onProgress: (p) => seen.push(p) })).toBe(true);
    expect(pulls).toEqual(['big/app:1']);
    expect(seen[0]).toEqual({ phase: 'pulling', message: 'pulling image big/app:1…' });
  });

  test('secret-env + image present + missing policy skips the pull', async () => {
    const { docker, pulls } = fakeDocker(true);
    expect(await prePullForDeploy(docker, secret, { pullPolicy: 'missing' })).toBe(false);
    expect(pulls).toEqual([]);
  });

  test('always re-pulls a present image; never does not pull', async () => {
    const a = fakeDocker(true);
    expect(await prePullForDeploy(a.docker, secret, { pullPolicy: 'always' })).toBe(true);
    const n = fakeDocker(false);
    expect(await prePullForDeploy(n.docker, secret, { pullPolicy: 'never' })).toBe(false);
    expect(n.pulls).toEqual([]);
  });

  test('progress heartbeats are throttled', async () => {
    let t = 0;
    const { docker } = fakeDocker(false, ['a', 'b', 'c', 'd']);
    const origPull = docker.pullImage;
    docker.pullImage = (i, au, cb) => origPull(i, au, (l) => { t += 3_000; cb?.(l); });
    const seen: CommandProgress[] = [];
    await prePullForDeploy(docker, secret, { onProgress: (p) => seen.push(p), throttleMs: 5_000, now: () => t });
    // initial + at t=6000 ('b') + at t=12000 ('d')
    expect(seen.map((p) => p.message)).toEqual([
      'pulling image big/app:1…',
      'pulling image big/app:1: b',
      'pulling image big/app:1: d',
    ]);
  });

  test('a pull failure propagates (the deploy fails with the real error)', async () => {
    const docker: DeployPullDocker = {
      imagePresent: async () => false,
      pullImage: async () => {
        throw new Error('pull big/app:1: no space left on device');
      },
    };
    await expect(prePullForDeploy(docker, secret)).rejects.toThrow('no space left on device');
  });
});
