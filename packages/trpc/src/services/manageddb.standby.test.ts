import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  DEFAULT_STANDBY_MIN_SERVERS,
  defaultStandbyReplicas,
  provisionDb,
  readyServerCount,
} from './manageddb.service';

// Owner decision (plans/epic-volume-mobility.md §5.1): a new managed Postgres
// gets one standby on a different server once there are 2+ ready servers.

const node = (id: string, over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo =>
  ({ swarmNodeId: id, hostname: id, role: 'manager', status: 'ready', availability: 'active', labels: {}, ...over }) as SwarmNodeInfo;

function world(nodes: SwarmNodeInfo[], services: SwarmServiceInfo[] = []) {
  const deploys: Array<{ name: string; replicas: number; constraints: string[]; labels: Record<string, string> }> = [];
  const hub = {
    managerNode: () => 'node1',
    isOnline: () => true,
    onlineNodeIds: () => ['node1'],
    latestContainers: () => [],
    nodeInventory: () => nodes,
    swarmNodeIdFor: () => nodes[0]?.swarmNodeId ?? 'swarm-a',
    liveInventory: () => ({ services, containers: [] }),
    dispatch: (_n: string, cmd: string, payload: Record<string, unknown>) => {
      if (cmd === 'service.deploy') {
        const spec = payload.spec as {
          name: string;
          mode: { replicated: { replicas: number } };
          placement?: { constraints?: string[] };
          labels: Record<string, string>;
        };
        deploys.push({
          name: spec.name,
          replicas: spec.mode.replicated.replicas,
          constraints: spec.placement?.constraints ?? [],
          labels: spec.labels,
        });
      }
      return Promise.resolve({});
    },
  };
  const ctx = {
    db: { auditLog: { create: () => Promise.resolve({}) } },
    hub,
    user: null,
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  return { ctx, deploys };
}

describe('defaultStandbyReplicas / readyServerCount (pure)', () => {
  it('one standby from 2 ready servers, none on a single server', () => {
    expect(DEFAULT_STANDBY_MIN_SERVERS).toBe(2);
    expect(defaultStandbyReplicas(0)).toBe(0);
    expect(defaultStandbyReplicas(1)).toBe(0);
    expect(defaultStandbyReplicas(2)).toBe(1);
    expect(defaultStandbyReplicas(5)).toBe(1);
  });

  it('counts only ready + active servers (paused/drained/down cannot take a standby)', () => {
    expect(
      readyServerCount([
        node('a'),
        node('b', { availability: 'pause' }),
        node('c', { status: 'down' }),
        node('d', { availability: 'drain' }),
      ]),
    ).toBe(1);
  });
});

describe('provisionDb — default standby', () => {
  it('two ready servers + no replicas given → 1 standby, anti-affine to the primary', async () => {
    const w = world([node('swarm-a'), node('swarm-b')]);
    const res = await provisionDb(w.ctx, { stack: 'shop', name: 'main', autoBackup: false });
    expect(res.replicas).toBe(1);
    expect(res.replicasDefaulted).toBe(true);
    const replica = w.deploys.find((d) => d.name === 'shop_main-replica')!;
    expect(replica.replicas).toBe(1);
    expect(replica.constraints).toContain('node.id!=swarm-a');
    expect(w.deploys.find((d) => d.name === 'shop_main-primary')!.labels['swarmy.db.replicas']).toBe('1');
  });

  it('one server → no standby', async () => {
    const w = world([node('swarm-a')]);
    const res = await provisionDb(w.ctx, { stack: 'shop', name: 'main', autoBackup: false });
    expect(res.replicas).toBe(0);
    expect(w.deploys.find((d) => d.name === 'shop_main-replica')!.replicas).toBe(0);
  });

  it('a second server that is paused does not count', async () => {
    const w = world([node('swarm-a'), node('swarm-b', { availability: 'pause' })]);
    expect((await provisionDb(w.ctx, { stack: 'shop', name: 'main', autoBackup: false })).replicas).toBe(0);
  });

  it('replicas: 0 opts out; an explicit count wins', async () => {
    const w = world([node('swarm-a'), node('swarm-b'), node('swarm-c')]);
    const off = await provisionDb(w.ctx, { stack: 'shop', name: 'main', replicas: 0, autoBackup: false });
    expect(off.replicas).toBe(0);
    expect(off.replicasDefaulted).toBe(false);
    const two = await provisionDb(w.ctx, { stack: 'shop', name: 'other', replicas: 2, autoBackup: false });
    expect(two.replicas).toBe(2);
  });
});
