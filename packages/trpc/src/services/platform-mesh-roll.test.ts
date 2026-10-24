import { describe, expect, it } from 'bun:test';
import { meshGuard, meshNodeBack, planMeshRoll, type MeshNodeObs } from './platform-mesh-roll';
import { rollMesh, rollMeshBack, type MeshRollIO } from './platform-mesh-roll.run';
import { newRunState, type StepContext } from './platform-upgrade.plan';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const OLD = `ghcr.io/netbirdio/netbird:0.79.0@${D('a')}`;
const NEW = `ghcr.io/netbirdio/netbird:0.80.0@${D('b')}`;
const target = { ref: 'ghcr.io/netbirdio/netbird:0.80.0', image: 'ghcr.io/netbirdio/netbird', digest: D('b') };
const T = { to: NEW, digest: D('b') };

const node = (id: string, over: Partial<MeshNodeObs> = {}): MeshNodeObs => ({
  id,
  name: `node-${id}`,
  online: true,
  supports: true,
  sidecar: OLD,
  peer: { status: 'CONNECTED', meshIp: `100.64.0.${id.charCodeAt(0) % 50}`, lastSeen: 0 },
  ...over,
});

describe('planMeshRoll + meshGuard + meshNodeBack (pure)', () => {
  it('rolls every connected client off the release; says why it leaves the rest alone', () => {
    const plan = planMeshRoll(
      [node('a'), node('b', { sidecar: null }), node('c', { sidecar: NEW }), node('d', { supports: false }), node('e', { peer: { status: 'DEGRADED', meshIp: null, lastSeen: 0 } })],
      T,
    );
    expect(plan.map((p) => (p.action === 'roll' ? `${p.id}:roll` : `${p.id}:${p.why}`))).toEqual([
      'a:roll',
      'b:no mesh client',
      'c:already on this release',
      'd:its agent is too old to move the mesh client',
      'e:its mesh was already down; left as it is',
    ]);
  });

  it('never takes the last connected server down; a single-server mesh goes alone', () => {
    const down = { status: 'DEGRADED', meshIp: null, lastSeen: 0 };
    expect(meshGuard([node('a'), node('b')], 'a')).toBeNull();
    expect(meshGuard([node('a'), node('b', { peer: down })], 'a')).toBe('no other server is on the private network right now');
    expect(meshGuard([node('a'), node('b', { sidecar: null, peer: null })], 'a')).toBeNull();
  });

  it('back = online, on the new build, a fresh CONNECTED report, the same mesh IP', () => {
    const ip = node('a').peer!.meshIp;
    expect(meshNodeBack(node('a', { sidecar: NEW, peer: { status: 'CONNECTED', meshIp: ip, lastSeen: 20 } }), T, 10, ip)).toEqual({ ok: true });
    expect(meshNodeBack(node('a', { sidecar: OLD }), T, 10, ip)).toMatchObject({ ok: false, why: expect.stringMatching(/not on the new build/) });
    expect(meshNodeBack(node('a', { sidecar: NEW, peer: { status: 'CONNECTED', meshIp: ip, lastSeen: 5 } }), T, 10, ip)).toMatchObject({ ok: false, why: expect.stringMatching(/report the mesh connected/) });
    expect(meshNodeBack(node('a', { sidecar: NEW, peer: { status: 'CONNECTED', meshIp: '100.64.9.9', lastSeen: 20 } }), T, 10, ip)).toMatchObject({ ok: false, why: expect.stringMatching(/came back as 100.64.9.9/) });
  });
});

/** Servers whose client moves on `reimage`, and report CONNECTED again (with a later lastSeen) one poll later. */
function world(ids: string[], opts: { failOn?: string; neverBack?: string } = {}) {
  let t = 1_000;
  const nodes = new Map(ids.map((id) => [id, node(id)]));
  const calls: string[] = [];
  const down = new Set<string>();
  const io: MeshRollIO = {
    observe: async () => [...nodes.values()].map((n) => ({ ...n, peer: n.peer && { ...n.peer } })),
    reimage: async (id, image) => {
      calls.push(`${id} ${image === NEW ? 'NEW' : image === OLD ? 'OLD' : image}`);
      if (opts.failOn === id) throw new Error('the mesh client on x did not reconnect within 90 s; the previous client is back');
      const n = nodes.get(id)!;
      n.sidecar = image;
      if (opts.neverBack !== id) down.add(id);
      else n.peer = { ...n.peer!, status: 'DEGRADED' };
      return { changed: true, from: OLD, to: image };
    },
    sleep: async (ms) => {
      t += ms;
      for (const id of down) nodes.get(id)!.peer = { ...nodes.get(id)!.peer!, status: 'CONNECTED', lastSeen: t };
      down.clear();
    },
    now: () => t,
  };
  const run = newRunState();
  const step = run.steps.find((s) => s.key === 'mesh')!;
  const c: StepContext = { run, step, checkpoint: async () => undefined, note: () => undefined };
  return { io, c, step, calls };
}

describe('rollMesh (the step over fake IO)', () => {
  it('moves each server in turn, the next only once the last is back on the mesh', async () => {
    const w = world(['a', 'b', 'c']);
    expect(await rollMesh(w.c, target, w.io)).toEqual({ status: 'done', detail: '3 server(s) on the new mesh client, one at a time' });
    expect(w.calls).toEqual(['a NEW', 'b NEW', 'c NEW']);
    expect(w.step.data?.nodes).toEqual({ a: 'moved', b: 'moved', c: 'moved' });
  });

  it('a server whose client the agent put back fails the step; rollback moves the earlier ones back, newest first', async () => {
    const w = world(['a', 'b', 'c'], { failOn: 'b' });
    await expect(rollMesh(w.c, target, w.io)).rejects.toThrow(/^node-b: the mesh client on x did not reconnect/);
    expect(w.step.data?.nodes).toEqual({ a: 'moved' });
    expect(await rollMeshBack(w.c, w.io)).toBe('node-a: mesh client back on the previous build');
    expect(w.calls).toEqual(['a NEW', 'b NEW', 'a OLD']);
  });

  it('one that never reports back fails after the wait (nothing else is touched)', async () => {
    const w = world(['a', 'b'], { neverBack: 'a' });
    await expect(rollMesh(w.c, target, w.io, { pollMs: 60_000, settleMs: 120_000, guardMs: 1 })).rejects.toThrow(/node-a: the mesh client did not come back on the new build/);
    expect(w.calls).toEqual(['a NEW']);
  });

  it('resumes on the server it was moving without sending it again, and skips when there is nothing to move', async () => {
    const w = world(['a', 'b']);
    w.step.data = { to: NEW, digest: D('b'), nodes: { a: 'dispatched' }, from: { a: OLD }, ipBefore: {}, at: { a: 0 } };
    await w.io.reimage('a', NEW); // what the old process sent before it stopped
    expect((await rollMesh(w.c, target, w.io)).status).toBe('done');
    expect(w.calls).toEqual(['a NEW', 'b NEW']);
    expect(await rollMesh(world([]).c, target, world([]).io)).toEqual({ status: 'skipped', detail: 'no server runs a mesh client' });
    expect((await rollMesh(world(['a']).c, { ...target, digest: undefined }, world(['a']).io)).status).toBe('skipped');
  });
});
