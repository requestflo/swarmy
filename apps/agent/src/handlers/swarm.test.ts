import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { SwarmJoinPayload } from '@swarmy/core/protocol';
import { applySwarmJoin, swarmRejoinInFlight } from './swarm';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

/** A fake local daemon: one swarm membership, a call log, and the rejoin flag seen mid-join. */
function fakeDocker(initial: { state: 'active' | 'inactive'; addr: string; id: string }) {
  const s = { ...initial };
  const calls: string[] = [];
  let flagDuringJoin: boolean | undefined;
  let joinOpts: Record<string, unknown> | undefined;
  const docker = {
    swarmState: async () => s.state,
    localSwarmAddr: async () => (s.state === 'active' ? s.addr : ''),
    swarmLeave: async () => {
      calls.push('leave');
      s.state = 'inactive';
    },
    swarmJoin: async (opts: Record<string, unknown>) => {
      if (s.state === 'active') return { swarmNodeId: s.id };
      calls.push('join');
      flagDuringJoin = swarmRejoinInFlight();
      joinOpts = opts;
      s.state = 'active';
      s.addr = String(opts.advertiseAddr ?? '');
      s.id = 'new-id';
      return { swarmNodeId: s.id };
    },
  } as unknown as DockerClient;
  return { docker, calls, state: s, flag: () => flagDuringJoin, opts: () => joinOpts };
}

const payload = (over: Partial<SwarmJoinPayload> = {}): SwarmJoinPayload => ({
  commandId: CMD_ID,
  mode: 'join',
  role: 'worker',
  joinToken: 'SWMTKN-1-x',
  managerAddr: '203.0.113.10:2377',
  advertiseAddr: '100.92.1.7',
  dataPathAddr: '100.92.1.7',
  ...over,
});

describe('applySwarmJoin — rejoin (mesh re-pin)', () => {
  it('leaves then joins on the mesh advertise + data-path addr, with the watchdog suppressed', async () => {
    const f = fakeDocker({ state: 'active', addr: '203.0.113.20', id: 'old-id' });
    const res = await applySwarmJoin(f.docker, payload({ rejoin: true }));
    expect(f.calls).toEqual(['leave', 'join']);
    expect(res).toEqual({ mode: 'join', swarmNodeId: 'new-id' });
    expect(f.opts()).toMatchObject({ advertiseAddr: '100.92.1.7', dataPathAddr: '100.92.1.7' });
    expect(f.flag()).toBe(true); // watchdog must not exit the agent mid-move
    expect(swarmRejoinInFlight()).toBe(false); // cleared afterwards
  });

  it('is idempotent: a node already on the target addr is left alone (resume-safe)', async () => {
    const f = fakeDocker({ state: 'active', addr: '100.92.1.7', id: 'already-id' });
    const res = await applySwarmJoin(f.docker, payload({ rejoin: true }));
    expect(f.calls).toEqual([]);
    expect(res.swarmNodeId).toBe('already-id');
  });

  it('joins directly when a previous attempt already left', async () => {
    const f = fakeDocker({ state: 'inactive', addr: '', id: '' });
    await applySwarmJoin(f.docker, payload({ rejoin: true }));
    expect(f.calls).toEqual(['join']);
  });

  it('clears the in-flight flag when the join throws', async () => {
    const f = fakeDocker({ state: 'active', addr: '203.0.113.20', id: 'old-id' });
    (f.docker as unknown as { swarmJoin: () => Promise<never> }).swarmJoin = async () => {
      throw new Error('manager unreachable');
    };
    await expect(applySwarmJoin(f.docker, payload({ rejoin: true }))).rejects.toThrow('manager unreachable');
    expect(swarmRejoinInFlight()).toBe(false);
  });

  it('without rejoin, an active node no-ops (the onboarding contract is unchanged)', async () => {
    const f = fakeDocker({ state: 'active', addr: '203.0.113.20', id: 'old-id' });
    const res = await applySwarmJoin(f.docker, payload());
    expect(f.calls).toEqual([]);
    expect(res.swarmNodeId).toBe('old-id');
  });

  it('reverse (off-mesh) rejoin with no advertise addr lets the agent derive one', async () => {
    const f = fakeDocker({ state: 'active', addr: '100.92.1.7', id: 'mesh-id' });
    await applySwarmJoin(f.docker, payload({ rejoin: true, advertiseAddr: undefined, dataPathAddr: undefined }));
    expect(f.calls).toEqual(['leave', 'join']);
    expect(f.opts()?.dataPathAddr).toBeUndefined();
  });
});
