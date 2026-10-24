import { describe, expect, test } from 'bun:test';
import { isDigestPinned, resolveMeshClientImage } from './mesh-image';

const UP = `ghcr.io/netbirdio/netbird:0.79.0@sha256:${'9'.repeat(64)}`;
const MIRROR = `localhost:5000/swarmy-system/ghcr.io/netbirdio/netbird@sha256:${'9'.repeat(64)}`;
const AUTH = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };

/** A fake Docker: `present` images inspect fine, `pullable` pulls succeed; every pull is logged. */
function fake(opts: { present?: string[]; pullable?: string[] } = {}) {
  const pulls: { ref: string; auth?: unknown }[] = [];
  const present = new Set(opts.present ?? []);
  return {
    pulls,
    docker: {
      pullImage: async (ref: string, auth?: unknown) => {
        pulls.push({ ref, auth });
        if (!(opts.pullable ?? []).includes(ref)) throw new Error(`pull ${ref} failed`);
        present.add(ref);
        return 'sha256:x';
      },
      docker: {
        getImage: (ref: string) => ({ inspect: async () => (present.has(ref) ? {} : Promise.reject(new Error('no such image'))) }),
      },
    },
  };
}

describe('mesh client image (M3 client mirror)', () => {
  test('no hint: the old behaviour (pull upstream; a failed pull still runs upstream)', async () => {
    const f = fake();
    expect(await resolveMeshClientImage(f.docker, UP)).toBe(UP);
    expect(f.pulls.map((p) => p.ref)).toEqual([UP]);
  });

  test('pinned upstream already on the node: run it with no network, even with a hint', async () => {
    const f = fake({ present: [UP] });
    expect(await resolveMeshClientImage(f.docker, UP, { mirrorImage: MIRROR, registryAuth: AUTH })).toBe(UP);
    expect(f.pulls).toEqual([]);
  });

  test('otherwise the cluster copy, pulled with the registry login', async () => {
    const f = fake({ pullable: [MIRROR] });
    expect(await resolveMeshClientImage(f.docker, UP, { mirrorImage: MIRROR, registryAuth: AUTH })).toBe(MIRROR);
    expect(f.pulls).toEqual([{ ref: MIRROR, auth: { username: 'swarmy', password: 'pw', serveraddress: 'localhost:5000' } }]);
  });

  test('registry unreachable (off the swarm, mesh down): falls back to upstream', async () => {
    const f = fake({ pullable: [UP] });
    expect(await resolveMeshClientImage(f.docker, UP, { mirrorImage: MIRROR })).toBe(UP);
    expect(f.pulls.map((p) => p.ref)).toEqual([MIRROR, UP]);
  });

  test('a floating upstream tag is never trusted as present: it still tries the copy', async () => {
    const tag = 'my/netbird:latest';
    const f = fake({ present: [tag], pullable: [MIRROR] });
    expect(await resolveMeshClientImage(f.docker, tag, { mirrorImage: MIRROR })).toBe(MIRROR);
    expect(isDigestPinned(UP)).toBe(true);
    expect(isDigestPinned(tag)).toBe(false);
  });
});
