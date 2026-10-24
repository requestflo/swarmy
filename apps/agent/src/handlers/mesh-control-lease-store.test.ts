import { describe, expect, it } from 'bun:test';
import { MESH_CONTROL_LEASE_CONFIG, MESH_CONTROL_LEASE_LABEL, MESH_LEASE } from '@swarmy/core/protocol';
import type { DockerClient } from '@swarmy/core/docker';
import { leaseIdentity, readMeshLease, writeMeshLease, type LeaseApi, type RawConfig } from './mesh-control-lease-store';
import { leaseTick, leaseView, mayReplicate, releaseLease, resetLease } from './mesh-control-lease';

/** Docker's config API as raft runs it: unique names, and label updates checked against the version. */
function fakeRaft(node = 'A', managers = 3) {
  const configs = new Map<string, RawConfig>();
  let seq = 10;
  const self = { node, managers, quorum: true };
  const guard = () => {
    if (!self.quorum) throw new Error('rpc error: code = Unknown desc = The swarm does not have a leader');
  };
  const api: LeaseApi = {
    info: async () => ({ Name: `host-${self.node}`, Swarm: { NodeID: self.node, LocalNodeState: 'active', ControlAvailable: true, Managers: self.quorum ? self.managers : 0 } }),
    listConfigs: async () => (guard(), [...configs.values()].map((c) => ({ ID: c.ID, Spec: c.Spec }))),
    getConfig: (id) => ({
      inspect: async () => (guard(), structuredClone(configs.get(id)!)),
      update: async (o) => {
        guard();
        const cur = configs.get(id)!;
        if (o.version !== cur.Version.Index) throw new Error('rpc error: code = Unknown desc = update out of sequence');
        if (o.Name !== cur.Spec.Name || o.Data !== cur.Spec.Data) throw new Error('only updates to Labels are allowed');
        configs.set(id, { ...cur, Version: { Index: ++seq }, Spec: { ...cur.Spec, Labels: o.Labels as Record<string, string> } });
      },
    }),
    createConfig: async (spec) => {
      guard();
      if ([...configs.values()].some((c) => c.Spec.Name === spec.Name)) throw new Error(`config ${spec.Name} already exists`);
      configs.set(`id${++seq}`, { ID: `id${seq}`, Version: { Index: seq }, Spec: spec });
    },
  };
  return { api, self, configs, docker: { docker: api } as unknown as DockerClient };
}

const op = <T extends object>(holder: string, extra: T) => ({ holder, node: holder, ttlMs: MESH_LEASE.ttlMs, ...extra });

describe('the lease object (config labels, CAS like the controller service)', () => {
  it('creates it on the first acquire, then renews and releases by version', async () => {
    const { api } = fakeRaft();
    expect(await readMeshLease(api)).toBeNull();
    const a = await writeMeshLease(api, { kind: 'lease.acquire', ...op('A', {}), minEpoch: 0 }, () => 5);
    expect(a).toMatchObject({ ok: true, lease: { holder: 'A', epoch: 1, renewedAt: 5 } });
    const obj = (await readMeshLease(api))!;
    expect(obj.spec.Name).toBe(MESH_CONTROL_LEASE_CONFIG);
    expect(obj.spec.Labels?.['swarmy.system']).toBe('true');
    expect(JSON.parse(obj.spec.Labels![MESH_CONTROL_LEASE_LABEL]!)).toMatchObject({ holder: 'A', epoch: 1 });
    expect(await writeMeshLease(api, { kind: 'lease.renew', ...op('A', { epoch: 1 }) }, () => 9)).toMatchObject({ ok: true, lease: { epoch: 1, renewedAt: 9 } });
    expect(await writeMeshLease(api, { kind: 'lease.renew', ...op('B', { epoch: 1 }) })).toMatchObject({ ok: false, reason: 'lost' });
    expect(await writeMeshLease(api, { kind: 'lease.release', holder: 'A', epoch: 1 })).toMatchObject({ ok: true, lease: { released: true } });
  });

  it('a stale version loses the race and reports what is live now', async () => {
    const { api, configs } = fakeRaft();
    await writeMeshLease(api, { kind: 'lease.acquire', ...op('A', {}), minEpoch: 0 });
    const getConfig = api.getConfig;
    // B's write lands between A's inspect and A's update.
    api.getConfig = (id) => {
      const real = getConfig(id);
      return {
        inspect: real.inspect,
        update: async (o) => {
          const cur = configs.get(id)!;
          configs.set(id, { ...cur, Version: { Index: cur.Version.Index + 100 } });
          return real.update(o);
        },
      };
    };
    expect(await writeMeshLease(api, { kind: 'lease.renew', ...op('A', { epoch: 1 }) })).toMatchObject({ ok: false, reason: 'conflict', lease: { holder: 'A' } });
  });

  it('who we are: managers only (the lease lives in raft)', async () => {
    const { api } = fakeRaft('n1', 3);
    expect(await leaseIdentity(api)).toEqual({ holder: 'n1', hostname: 'host-n1', managers: 3 });
    const worker = { ...api, info: async () => ({ Swarm: { NodeID: 'w', LocalNodeState: 'active', ControlAvailable: false } }) };
    expect(await leaseIdentity(worker)).toBe('this node is not a swarm manager (the lease lives in raft)');
  });
});

describe('the agent side: hold, fence, take over', () => {
  const hooks = (fenced: string[]) => ({ fence: async (why: string) => void fenced.push(why), killReplica: async () => undefined, log: () => undefined });

  it('holds a free lease and replicates; a silent raft stops nothing at once', async () => {
    resetLease();
    const r = fakeRaft('A');
    expect(await leaseTick(r.docker, hooks([]))).toMatchObject({ state: 'held', epoch: 1, replicate: true });
    r.self.quorum = false;
    expect(await leaseTick(r.docker, hooks([]))).toMatchObject({ state: 'silent', replicate: true });
    await releaseLease(r.docker);
  });

  it('the returning old node fences before it ever replicates', async () => {
    resetLease();
    const r = fakeRaft('A');
    await writeMeshLease(r.api, { kind: 'lease.acquire', ...op('B', {}), minEpoch: 3 });
    const fenced: string[] = [];
    expect(await leaseTick(r.docker, hooks(fenced))).toMatchObject({ state: 'lost', holderNode: 'B', replicate: false });
    expect(fenced).toEqual(['the lease is held by B (epoch 4): this node is no longer the control plane']);
    expect(mayReplicate()).toBe(false);
  });

  it('told to host, it waits while the holder keeps renewing; a release hands over at once', async () => {
    resetLease();
    const r = fakeRaft('B');
    await writeMeshLease(r.api, { kind: 'lease.acquire', ...op('A', {}), minEpoch: 0 });
    expect(await leaseTick(r.docker, hooks([]), { intent: true })).toMatchObject({ state: 'waiting', holderNode: 'A' });
    await writeMeshLease(r.api, { kind: 'lease.release', holder: 'A', epoch: 1 });
    expect(await leaseTick(r.docker, hooks([]))).toMatchObject({ state: 'held', epoch: 2 });
    expect(leaseView().holderNode).toBe('B');
    await releaseLease(r.docker);
  });
});
