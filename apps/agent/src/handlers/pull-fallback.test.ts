import { describe, expect, test } from 'bun:test';
import { authForImage, presentOrFallback, pullWithFallback } from './pull-fallback';

function fakeDocker(opts: { pullable: string[]; present: string[] }) {
  const pulled: string[] = [];
  return {
    pulled,
    pullImage: async (ref: string) => {
      if (!opts.pullable.includes(ref)) throw new Error('pull failed');
      pulled.push(ref);
      return 'sha256:x';
    },
    docker: {
      getImage: (ref: string) => ({
        inspect: async () => {
          if (!opts.present.includes(ref) && !pulled.includes(ref)) throw new Error('no such image');
          return {};
        },
      }),
    },
  };
}

const MIRROR = 'localhost:5000/swarmy-system/docker.io/curlimages/curl@sha256:a';
const UP = 'curlimages/curl:8.10.1';

describe('pullWithFallback', () => {
  test('the mirror pulls → the mirror runs', async () => {
    const d = fakeDocker({ pullable: [MIRROR, UP], present: [] });
    expect(await pullWithFallback(d as never, MIRROR, UP)).toBe(MIRROR);
  });
  test('registry down, image not on the node → upstream', async () => {
    const d = fakeDocker({ pullable: [UP], present: [] });
    expect(await pullWithFallback(d as never, MIRROR, UP)).toBe(UP);
    expect(d.pulled).toEqual([UP]);
  });
  test('registry down but the mirror copy is already on the node → keep it', async () => {
    const d = fakeDocker({ pullable: [], present: [MIRROR] });
    expect(await pullWithFallback(d as never, MIRROR, UP)).toBe(MIRROR);
  });
  test('no fallback → the preferred ref (Docker reports the miss)', async () => {
    const d = fakeDocker({ pullable: [], present: [] });
    expect(await pullWithFallback(d as never, MIRROR, undefined)).toBe(MIRROR);
  });
});

describe('presentOrFallback (pull: false)', () => {
  test('prefers what is staged on the node', async () => {
    expect(await presentOrFallback(fakeDocker({ pullable: [], present: [MIRROR] }) as never, MIRROR, UP)).toBe(MIRROR);
    expect(await presentOrFallback(fakeDocker({ pullable: [], present: [UP] }) as never, MIRROR, UP)).toBe(UP);
    expect(await presentOrFallback(fakeDocker({ pullable: [], present: [] }) as never, MIRROR, UP)).toBe(MIRROR);
  });
});

describe('authForImage', () => {
  test('only the matching registry host gets the login', () => {
    const a = { username: 'u', password: 'p', server: 'localhost:5000' };
    expect(authForImage(MIRROR, a)).toBe(a);
    expect(authForImage('moby/buildkit:rootless', a)).toBeUndefined();
    expect(authForImage(MIRROR, undefined)).toBeUndefined();
  });
});
