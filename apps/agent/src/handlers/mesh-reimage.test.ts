import { describe, expect, it } from 'bun:test';
import { NETBIRD_CONTAINER, PREV_CONTAINER, reimageMeshClient, type ReimageDeps } from './mesh-reimage';
import { reconnected, reimageSpec } from './mesh-reimage-spec';

const OLD = 'ghcr.io/netbirdio/netbird:0.79.0@sha256:' + 'a'.repeat(64);
const NEW = 'ghcr.io/netbirdio/netbird:0.80.0@sha256:' + 'b'.repeat(64);
const HOST = { NetworkMode: 'host', CapAdd: ['NET_ADMIN'], Binds: ['swarmy-netbird:/var/lib/netbird'] };
const CMD = '66666666-6666-4666-8666-666666666666';

describe('reimageSpec', () => {
  it("clones what the creator set, never what the old image baked in", () => {
    const cur = {
      Id: 'c1',
      Image: 'img-old',
      Config: { Image: OLD, Env: ['PATH=/usr/bin', 'NB_MANAGEMENT_URL=https://mesh.x'], Cmd: ['up'], Labels: { 'org.opencontainers.image.version': '0.79.0', 'swarmy.x': '1' } },
      HostConfig: HOST,
    };
    const old = { Env: ['PATH=/usr/bin'], Cmd: ['up'], Labels: { 'org.opencontainers.image.version': '0.79.0' } };
    expect(reimageSpec(cur, old, NEW, NETBIRD_CONTAINER)).toEqual({
      name: NETBIRD_CONTAINER,
      Image: NEW,
      Env: ['NB_MANAGEMENT_URL=https://mesh.x'],
      Labels: { 'swarmy.x': '1' },
      HostConfig: HOST,
    });
  });

  it('back = connected with the same mesh IP; another IP is a new peer', () => {
    expect(reconnected({ driver: 'netbird', connected: true, meshIp: '100.64.0.2' }, '100.64.0.2').ok).toBe(true);
    expect(reconnected({ driver: 'netbird', connected: false }, '100.64.0.2').why).toBe('not connected yet');
    expect(reconnected({ driver: 'netbird', connected: true, meshIp: '100.64.0.9' }, '100.64.0.2').why).toMatch(/new peer/);
  });
});

/** Containers by name; ids are the names they were born with. */
function fakeDocker(opts: { withClient?: boolean; withPrev?: boolean; pullable?: boolean } = {}) {
  const log: string[] = [];
  const byName = new Map<string, { id: string; image: string; running: boolean }>();
  if (opts.withClient !== false) byName.set(NETBIRD_CONTAINER, { id: 'c-old', image: 'img-old', running: true });
  if (opts.withPrev) byName.set(PREV_CONTAINER, { id: 'c-prev', image: 'img-old', running: false });
  const find = (ref: string) => [...byName.entries()].find(([n, c]) => n === ref || c.id === ref);
  const container = (ref: string) => ({
    inspect: async () => {
      const f = find(ref);
      if (!f) throw new Error('no such container');
      return { Id: f[1].id, Image: f[1].image, State: { Running: f[1].running }, Config: { Image: f[1].image === 'img-old' ? OLD : NEW, Env: [] }, HostConfig: HOST };
    },
    stop: async () => void (log.push(`stop ${find(ref)![0]}`), (find(ref)![1].running = false)),
    start: async () => void (log.push(`start ${find(ref)![0]}`), (find(ref)![1].running = true)),
    remove: async () => {
      const f = find(ref);
      if (f) (log.push(`remove ${f[0]}`), byName.delete(f[0]));
    },
    rename: async ({ name }: { name: string }) => {
      const [n, c] = find(ref)!;
      byName.delete(n);
      byName.set(name, c);
      log.push(`rename ${n} → ${name}`);
    },
  });
  const docker: any = {
    pullImage: async () => (opts.pullable === false ? Promise.reject(new Error('pull failed')) : undefined),
    docker: {
      getContainer: container,
      getImage: (ref: string) => ({
        inspect: async () => (ref === NEW && opts.pullable !== false ? { Id: 'img-new', Config: {} } : ref === 'img-old' ? { Id: 'img-old', Config: {} } : Promise.reject(new Error('no image'))),
      }),
      createContainer: async (spec: { name: string; Image: string }) => {
        byName.set(spec.name, { id: 'c-new', image: 'img-new', running: false });
        log.push(`create ${spec.name} ${spec.Image === NEW ? 'NEW' : spec.Image}`);
        return container('c-new');
      },
    },
  };
  return { docker, log, byName };
}

function deps(samples: Array<{ connected: boolean; meshIp?: string }>): ReimageDeps {
  let t = 0;
  return {
    sample: async () => ({ driver: 'netbird', ...(samples.length > 1 ? samples.shift()! : samples[0]!) }),
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
}

describe('reimageMeshClient', () => {
  const up = { connected: true, meshIp: '100.64.0.2' };
  it('swaps onto the new image, waits for the same peer to reconnect, then drops the old one', async () => {
    const w = fakeDocker();
    const r = await reimageMeshClient(w.docker, { commandId: CMD, image: NEW, reconnectTimeoutMs: 90_000 }, deps([up, { connected: false }, up]));
    expect(r).toEqual({ changed: true, from: OLD, to: NEW, meshIp: '100.64.0.2' });
    expect(w.log).toEqual([`stop ${NETBIRD_CONTAINER}`, `rename ${NETBIRD_CONTAINER} → ${PREV_CONTAINER}`, `create ${NETBIRD_CONTAINER} NEW`, `start ${NETBIRD_CONTAINER}`, `remove ${PREV_CONTAINER}`]);
    expect([...w.byName.keys()]).toEqual([NETBIRD_CONTAINER]);
  });

  it('a client that never reconnects is replaced by the old one, here, and the command fails', async () => {
    const w = fakeDocker();
    const err = await reimageMeshClient(w.docker, { commandId: CMD, image: NEW, reconnectTimeoutMs: 10_000 }, deps([up, { connected: false }, { connected: false }])).catch((e) => e);
    expect(err.message).toMatch(/did not reconnect within 10 s; the previous client .* is back/);
    expect(err.code).toBe('E_MESH_REIMAGE');
    expect(w.log.slice(-3)).toEqual([`remove ${NETBIRD_CONTAINER}`, `rename ${PREV_CONTAINER} → ${NETBIRD_CONTAINER}`, `start ${NETBIRD_CONTAINER}`]);
    expect(w.byName.get(NETBIRD_CONTAINER)).toMatchObject({ id: 'c-old', running: true });
  });

  it('touches nothing when there is no client, it already runs the image, or the pull fails', async () => {
    expect(await reimageMeshClient(fakeDocker({ withClient: false }).docker, { commandId: CMD, image: NEW, reconnectTimeoutMs: 1 }, deps([up]))).toEqual({ changed: false, reason: 'no-client' });
    const same = fakeDocker();
    expect((await reimageMeshClient(same.docker, { commandId: CMD, image: 'img-old', reconnectTimeoutMs: 1 }, deps([up]))).reason).toBe('same-image');
    const offline = fakeDocker({ pullable: false });
    await expect(reimageMeshClient(offline.docker, { commandId: CMD, image: NEW, reconnectTimeoutMs: 1 }, deps([up]))).rejects.toThrow(/was not touched/);
    expect([...same.log, ...offline.log]).toEqual([]);
  });

  it('heals a swap a crash left half-done: the old client comes back before anything else', async () => {
    const w = fakeDocker({ withClient: false, withPrev: true });
    await reimageMeshClient(w.docker, { commandId: CMD, image: NEW, reconnectTimeoutMs: 90_000 }, deps([up]));
    expect(w.log.slice(0, 2)).toEqual([`rename ${PREV_CONTAINER} → ${NETBIRD_CONTAINER}`, `start ${NETBIRD_CONTAINER}`]);
  });
});
