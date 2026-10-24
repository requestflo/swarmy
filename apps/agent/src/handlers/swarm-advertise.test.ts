import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { SwarmJoinPayload } from '@swarmy/core/protocol';
import { applySwarmJoin } from './swarm';
import { defaultAdvertiseAddr } from './swarm-advertise';

const CMD_ID = '00000000-0000-4000-8000-000000000002';

/** A fake local daemon off-swarm that records what init/join were asked to advertise. */
function fakeDocker() {
  const seen: { join?: Record<string, unknown>; init?: string | undefined; initCalled?: boolean } = {};
  const docker = {
    info: async () => ({ Swarm: { LocalNodeState: 'inactive' } }),
    swarmState: async () => 'inactive',
    swarmJoin: async (opts: Record<string, unknown>) => {
      seen.join = opts;
      return { swarmNodeId: 'n1' };
    },
    swarmInit: async (advertiseAddr?: string) => {
      seen.initCalled = true;
      seen.init = advertiseAddr;
      return { swarmNodeId: 'n1', managerAddr: '10.0.0.1:2377', joinTokens: { worker: 'w', manager: 'm' } };
    },
  } as unknown as DockerClient;
  return { docker, seen };
}

const join = (over: Partial<SwarmJoinPayload> = {}): SwarmJoinPayload => ({
  commandId: CMD_ID,
  mode: 'join',
  role: 'worker',
  joinToken: 'SWMTKN-1-x',
  managerAddr: '127.0.0.1:2377',
  ...over,
});

const bridge = async () => false;
const host = async () => true;

describe('swarm advertise address when the controller pins none', () => {
  it('a bridge-network container agent advertises nothing on join: dockerd picks the host route', async () => {
    // Its own route starts at its container IP (172.17.0.x): unreachable from
    // every other node, so gossip (service DNS) and VXLAN would go nowhere.
    const f = fakeDocker();
    await applySwarmJoin(f.docker, join(), bridge);
    expect(f.seen.join).toMatchObject({ managerAddr: '127.0.0.1:2377', joinToken: 'SWMTKN-1-x' });
    expect(f.seen.join?.advertiseAddr).toBeUndefined();
    expect(f.seen.join?.dataPathAddr).toBeUndefined();
  });

  it('an agent on the host network pins the source address of its route to the manager', async () => {
    const f = fakeDocker();
    await applySwarmJoin(f.docker, join(), host);
    expect(f.seen.join?.advertiseAddr).toBe('127.0.0.1');
  });

  it('a controller-pinned (mesh) address always wins, without probing the network mode', async () => {
    const f = fakeDocker();
    let probed = false;
    const probe = async () => ((probed = true), false);
    await applySwarmJoin(f.docker, join({ advertiseAddr: '100.92.1.7', dataPathAddr: '100.92.1.7' }), probe);
    expect(f.seen.join).toMatchObject({ advertiseAddr: '100.92.1.7', dataPathAddr: '100.92.1.7' });
    expect(probed).toBe(false);
  });

  it('a bridge agent inits with no advertise addr (dockerd chooses, or refuses on a multi-homed box)', async () => {
    const f = fakeDocker();
    await applySwarmJoin(f.docker, { commandId: CMD_ID, mode: 'init' } as SwarmJoinPayload, bridge);
    expect(f.seen.initCalled).toBe(true);
    expect(f.seen.init).toBeUndefined();
  });

  it('defaultAdvertiseAddr only reads the local route on the host network', async () => {
    expect(await defaultAdvertiseAddr('127.0.0.1', false)).toBeUndefined();
    expect(await defaultAdvertiseAddr('127.0.0.1', true)).toBe('127.0.0.1');
  });
});
