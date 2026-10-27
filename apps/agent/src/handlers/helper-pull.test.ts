import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { dataImage } from '@swarmy/core/data-images';
import { helperDefault, type ListSnapshotsPayload } from '@swarmy/core/protocol';
import { listSnapshots } from './backup';
import { pinnedOnNode, pullHelper } from './helper-pull';
import { dbPitrWindow } from './pitr-window';

// A mirrored sidecar image: pull the in-cluster copy with the mirror login,
// then the upstream fallback when the mirror can't serve it.
const D = (c: string) => `sha256:${c.repeat(64)}`;
const UP = `${dataImage('restic').ref}@${dataImage('restic').digest}`;
const MIRROR = `localhost:5000/swarmy-system/docker.io/restic/restic:0.16.4@${dataImage('restic').digest}`;
const AUTH = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };
const LOGIN = { username: 'swarmy', password: 'pw', serveraddress: 'localhost:5000' };

/** Docker that can pull `pullable` (anonymously or not, per `needsLogin`) and has `present` on the node. */
function fakeDocker(o: { pullable?: string[]; present?: string[]; needsLogin?: string[] } = {}) {
  const pulls: { ref: string; auth?: unknown }[] = [];
  const created: string[] = [];
  const on = new Set(o.present ?? []);
  const docker = {
    pullImage: async (ref: string, auth?: unknown) => {
      pulls.push({ ref, ...(auth ? { auth } : {}) });
      if (!(o.pullable ?? []).includes(ref) || ((o.needsLogin ?? []).includes(ref) && !auth)) throw new Error(`pull ${ref} failed`);
      on.add(ref);
      return 'sha256:x';
    },
    docker: {
      getImage: (ref: string) => ({
        inspect: async () => {
          if (!on.has(ref)) throw new Error('no such image');
          return { Config: { User: '' } };
        },
      }),
      getNetwork: () => ({ connect: async () => undefined }),
      modem: { demuxStream: (_s: unknown, out: { write(b: Buffer): void }) => out.write(Buffer.from('[]')) },
      createContainer: async (opts: { Image: string }) => {
        created.push(opts.Image);
        return { id: 'c', attach: async () => ({}), start: async () => undefined, wait: async () => ({ StatusCode: 0 }), remove: async () => undefined };
      },
    },
  } as unknown as DockerClient;
  return { docker, pulls, created };
}

describe('pullHelper — mirrored copy first, then upstream', () => {
  it('the mirror serves it → the copy runs, pulled with the mirror login', async () => {
    const f = fakeDocker({ pullable: [MIRROR, UP], needsLogin: [MIRROR] });
    expect(await pullHelper(f.docker, 'restic', MIRROR, UP, AUTH)).toBe(MIRROR);
    expect(f.pulls).toEqual([{ ref: MIRROR, auth: LOGIN }]);
  });

  it('the mirror is down and the copy is not on the node → the upstream fallback, pulled without the login', async () => {
    const f = fakeDocker({ pullable: [UP] });
    expect(await pullHelper(f.docker, 'restic', MIRROR, UP, AUTH)).toBe(UP);
    expect(f.pulls).toEqual([{ ref: MIRROR, auth: LOGIN }, { ref: UP }]);
  });

  it('the mirror is down but the copy is already here → keep the copy', async () => {
    const f = fakeDocker({ present: [MIRROR] });
    expect(await pullHelper(f.docker, 'restic', MIRROR, UP, AUTH)).toBe(MIRROR);
  });

  it('an older controller (no fallback, no login) → nothing pulled here, the default as before', async () => {
    const f = fakeDocker();
    expect(await pullHelper(f.docker, 'restic', undefined, undefined, undefined)).toBe(helperDefault('restic'));
    expect(await pullHelper(f.docker, 'restic', UP, undefined, undefined)).toBe(UP);
    expect(f.pulls).toEqual([]);
  });

  it("a fallback that is the bare tag still runs the agent's pinned default", async () => {
    const f = fakeDocker({ pullable: [helperDefault('restic')] });
    expect(await pullHelper(f.docker, 'restic', MIRROR, dataImage('restic').ref, AUTH)).toBe(helperDefault('restic'));
  });
});

describe('sidecars follow the same order', () => {
  const list = (p: Partial<ListSnapshotsPayload>): ListSnapshotsPayload => ({
    commandId: '00000000-0000-4000-8000-000000000001',
    repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/b/p', password: 'p' },
    tags: [],
    ...p,
  });

  it('mirror up: both restic runs use the copy, pulled once with the login and never anonymously', async () => {
    const f = fakeDocker({ pullable: [MIRROR], needsLogin: [MIRROR] });
    await listSnapshots(f.docker, list({ image: MIRROR, fallbackImage: UP, registryAuth: AUTH }));
    expect(f.created).toEqual([MIRROR, MIRROR]);
    expect(f.pulls).toEqual([{ ref: MIRROR, auth: LOGIN }]);
  });

  it('mirror down: both restic runs use upstream', async () => {
    const f = fakeDocker({ pullable: [UP] });
    await listSnapshots(f.docker, list({ image: MIRROR, fallbackImage: UP, registryAuth: AUTH }));
    expect(f.created).toEqual([UP, UP]);
  });

  it('wal-g window reads fall back the same way', async () => {
    const walgUp = `${dataImage('walg').ref}@${D('a')}`;
    const walgMirror = `localhost:5000/swarmy-system/ghcr.io/requestflo/swarmy-walg:latest@${D('a')}`;
    const f = fakeDocker({ pullable: [walgUp] });
    const p = { commandId: '00000000-0000-4000-8000-000000000002', engine: 'wal-g' as const, repo: list({}).repo };
    await dbPitrWindow(f.docker, { ...p, engineImage: walgMirror, fallbackEngineImage: walgUp, registryAuth: AUTH });
    expect(f.created).toEqual([walgUp]);
  });
});

describe('pinnedOnNode', () => {
  it('only a digest-pinned ref already on the node skips the pull', async () => {
    const f = fakeDocker({ present: [UP, 'restic/restic:0.16.4'] });
    expect(await pinnedOnNode(f.docker, UP)).toBe(true);
    expect(await pinnedOnNode(f.docker, 'restic/restic:0.16.4')).toBe(false);
    expect(await pinnedOnNode(f.docker, MIRROR)).toBe(false);
    expect(await pinnedOnNode({} as never, UP)).toBe(false);
  });
});
