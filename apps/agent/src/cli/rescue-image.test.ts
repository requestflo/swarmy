import { describe, expect, it } from 'bun:test';
import { dataImage } from '@swarmy/core/data-images';
import { MIRROR_NODE_LABEL, mirrorLabelKey } from '@swarmy/core/system-images';
import { readLocalMirror, rescueCandidates, rescueLogin, resolveRescueImage, type LocalMirror } from './rescue-image';

// Controller-dark rescue backups pick their sidecar image from what the node
// itself has: the compiled BOM's digest, the mirror labels a manager can read,
// the images already here. No controller involved.
const restic = dataImage('restic');
const UP = `${restic.ref}@${restic.digest}`;
const COPY = `localhost:5000/swarmy-system/docker.io/restic/restic:0.16.4@${restic.digest}`;
const ALPINE_D = `sha256:${'c'.repeat(64)}`;
const mirror: LocalMirror = {
  labels: { [mirrorLabelKey('restic')]: UP, [mirrorLabelKey('alpine')]: `alpine:3.20@${ALPINE_D}`, [MIRROR_NODE_LABEL]: 'swarm-n1' },
  registryNodeId: 'swarm-n1',
};
const LOGIN = { username: 'swarmy', password: 'pw', serveraddress: 'localhost:5000' };

function fakeDocker(o: { present?: string[]; pullable?: string[] } = {}) {
  const pulls: { ref: string; auth?: unknown }[] = [];
  const on = new Set(o.present ?? []);
  return {
    pulls,
    pullImage: async (ref: string, auth?: unknown) => {
      pulls.push({ ref, ...(auth ? { auth } : {}) });
      if (!(o.pullable ?? []).includes(ref)) throw new Error('pull failed');
      on.add(ref);
      return 'sha256:x';
    },
    docker: {
      getImage: (ref: string) => ({
        inspect: async () => {
          if (!on.has(ref)) throw new Error('no such image');
          return {};
        },
      }),
    },
  };
}

describe('rescueCandidates (pure)', () => {
  it('restic by its compiled digest; the copy at that digest needs no labels to be recognised', () => {
    expect(rescueCandidates('restic', null)).toEqual({ upstream: UP, copy: COPY, trusted: false });
    expect(rescueCandidates('restic', mirror)).toEqual({ upstream: UP, copy: COPY, trusted: true });
    expect(rescueCandidates('restic', { ...mirror, registryNodeId: 'swarm-n2' }).trusted).toBe(false);
  });

  it("alpine (no compiled digest) has a copy only when the labels vouch for one", () => {
    expect(rescueCandidates('alpine', null)).toEqual({ upstream: 'alpine:3.20', copy: null, trusted: false });
    const c = rescueCandidates('alpine', mirror);
    expect(c.copy).toBe(`localhost:5000/swarmy-system/docker.io/library/alpine:3.20@${ALPINE_D}`);
    expect(c.trusted).toBe(true);
  });
});

describe('resolveRescueImage — what is here, then the mirror, then upstream', () => {
  it('an image already on the node runs with no pull at all (the copy first)', async () => {
    for (const [present, want] of [[[COPY, UP], COPY], [[UP], UP]] as const) {
      const d = fakeDocker({ present: [...present] });
      expect(await resolveRescueImage(d, 'restic', null, undefined)).toEqual({ image: want, source: 'node' });
      expect(d.pulls).toEqual([]);
    }
  });

  it('a trusted copy is pulled from the mirror with the operator login', async () => {
    const d = fakeDocker({ pullable: [COPY, UP] });
    expect(await resolveRescueImage(d, 'restic', mirror, LOGIN)).toEqual({ image: COPY, source: 'mirror' });
    expect(d.pulls).toEqual([{ ref: COPY, auth: LOGIN }]);
  });

  it('no login, an untrusted mirror or a failed mirror pull → upstream by digest', async () => {
    const noLogin = fakeDocker({ pullable: [COPY, UP] });
    expect(await resolveRescueImage(noLogin, 'restic', mirror, undefined)).toEqual({ image: UP, source: 'upstream' });
    expect(noLogin.pulls).toEqual([{ ref: UP }]);
    const moved = fakeDocker({ pullable: [COPY, UP] });
    expect((await resolveRescueImage(moved, 'restic', { ...mirror, registryNodeId: 'swarm-n2' }, LOGIN)).source).toBe('upstream');
    const down = fakeDocker({ pullable: [UP] });
    expect(await resolveRescueImage(down, 'restic', mirror, LOGIN)).toEqual({ image: UP, source: 'upstream' });
    expect(down.pulls).toEqual([{ ref: COPY, auth: LOGIN }, { ref: UP }]);
  });

  it('nothing here and nothing pullable says so, with the way out', async () => {
    await expect(resolveRescueImage(fakeDocker(), 'restic', mirror, undefined)).rejects.toThrow(/SWARMY_REGISTRY_PASSWORD.*docker load/);
    await expect(resolveRescueImage(fakeDocker(), 'restic', null, undefined)).rejects.toThrow(`${UP} is not on this node`);
  });
});

describe('what the node reads on its own', () => {
  it('rescueLogin: only from the environment, username defaults to swarmy', () => {
    expect(rescueLogin({ SWARMY_REGISTRY_PASSWORD: 'pw' })).toEqual(LOGIN);
    expect(rescueLogin({ SWARMY_REGISTRY_PASSWORD: 'pw', SWARMY_REGISTRY_USERNAME: 'ops' })?.username).toBe('ops');
    expect(rescueLogin({})).toBeUndefined();
  });

  it("readLocalMirror: a manager reads the registry's labels and its running task's node; a worker reads nothing", async () => {
    const manager = {
      docker: {
        getService: () => ({ inspect: async () => ({ Spec: { Labels: mirror.labels } }) }),
        listTasks: async () => [{ NodeID: 'old', Status: { State: 'shutdown' } }, { NodeID: 'swarm-n1', Status: { State: 'running' } }],
      },
    };
    expect(await readLocalMirror(manager as never)).toEqual(mirror);
    const worker = { docker: { getService: () => ({ inspect: async () => Promise.reject(new Error('not a swarm manager')) }) } };
    expect(await readLocalMirror(worker as never)).toBeNull();
  });
});
