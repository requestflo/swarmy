import { beforeAll, describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo, SwarmState } from '@swarmy/core/protocol';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-foreign-swarm';
});

import { foreignSwarmOf, getNode, listNodes } from './node.service';
import { FOREIGN_SWARM_DETAIL, FOREIGN_SWARM_FIX, foreignSwarmDetail, orchestrateSwarmMembership, swarmOrchestrationStatus } from './swarm.service';

/**
 * QA-065: swarmy-mac was still a worker of a torn-down cluster's swarm. It
 * re-enrolled, showed ONLINE, and never joined: the planner no-ops on "already
 * in a swarm", and nothing checked WHICH swarm.
 */
const listed = (hostname: string) => ({ swarmNodeId: `sw-${hostname}`, hostname, role: 'worker', status: 'ready', availability: 'active', labels: {} }) as unknown as SwarmNodeInfo;

function hub(o: { managers: string[]; states: Record<string, SwarmState>; listedHosts: string[]; hostnames: Record<string, string> }) {
  return {
    managerNodes: () => o.managers,
    isOnline: () => true,
    swarmStateFor: (id: string) => o.states[id],
    nodeInfoFor: (id: string) => (o.listedHosts.includes(o.hostnames[id] ?? '') ? listed(o.hostnames[id]!) : undefined),
    lastSeen: () => Date.now(),
    latestNodeStats: () => undefined,
    agentBuildFor: () => undefined,
    swarmNodeIdFor: () => undefined,
  };
}

const cluster = hub({
  managers: ['lon1-a'],
  states: { 'lon1-a': 'active', 'nyc1-a': 'active', 'swarmy-mac': 'active' },
  listedHosts: ['lon1-a', 'nyc1-a'], // swarmy-mac is in ANOTHER swarm: this cluster's manager doesn't list it
  hostnames: { 'lon1-a': 'lon1-a', 'nyc1-a': 'nyc1-a', 'swarmy-mac': 'swarmy-mac' },
});

describe('foreignSwarmDetail (pure)', () => {
  const base = { inSwarm: true, isManager: false, otherLiveManagers: 1, listedByOrgSwarm: false };
  it('in a swarm, a live org manager, and not listed by it ⇒ foreign', () => {
    expect(foreignSwarmDetail(base)).toBe(FOREIGN_SWARM_DETAIL);
  });
  it('listed, off-swarm, a manager itself, or no manager to compare with ⇒ not flagged', () => {
    expect(foreignSwarmDetail({ ...base, listedByOrgSwarm: true })).toBeNull();
    expect(foreignSwarmDetail({ ...base, inSwarm: false })).toBeNull();
    expect(foreignSwarmDetail({ ...base, isManager: true })).toBeNull();
    expect(foreignSwarmDetail({ ...base, otherLiveManagers: 0 })).toBeNull();
  });
});

describe('foreignSwarmOf (live hub truth)', () => {
  it('flags the stale-swarm worker and nobody else', () => {
    expect(foreignSwarmOf(cluster as never, 'o1', 'swarmy-mac')).toBe(FOREIGN_SWARM_DETAIL);
    expect(foreignSwarmOf(cluster as never, 'o1', 'nyc1-a')).toBeNull();
    expect(foreignSwarmOf(cluster as never, 'o1', 'lon1-a')).toBeNull();
  });
});

const rows = [
  { id: 'nyc1-a', name: 'nyc1-a', hostname: 'nyc1-a', createdAt: new Date() },
  { id: 'swarmy-mac', name: 'swarmy-mac', hostname: 'swarmy-mac', createdAt: new Date() },
];
const ctx = (h: unknown) =>
  ({
    activeOrgId: 'o1',
    hub: h,
    db: {
      node: {
        findMany: async () => rows,
        findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      },
    },
  }) as never;

describe('the node page', () => {
  it('a node in a foreign swarm is degraded, never ONLINE', async () => {
    const list = await listNodes(ctx(cluster));
    expect(list.find((n) => n.id === 'swarmy-mac')?.status).toBe('degraded');
    expect(list.find((n) => n.id === 'nyc1-a')?.status).toBe('online');
  });

  it('says why and gives the one-line fix; clears once the node is in this swarm', async () => {
    const d = await getNode(ctx(cluster), 'swarmy-mac');
    expect(d.swarmOrchestration).toMatchObject({ state: 'failed', detail: FOREIGN_SWARM_DETAIL, fix: FOREIGN_SWARM_FIX });
    const fixed = hub({
      managers: ['lon1-a'],
      states: { 'swarmy-mac': 'active' },
      listedHosts: ['lon1-a', 'swarmy-mac'],
      hostnames: { 'lon1-a': 'lon1-a', 'swarmy-mac': 'swarmy-mac' },
    });
    expect((await getNode(ctx(fixed), 'swarmy-mac')).swarmOrchestration ?? null).toBeNull();
  });
});

describe('the join on register explains it instead of a silent no-op', () => {
  it('records failed + the fix for a node already in a foreign swarm', async () => {
    const out = await orchestrateSwarmMembership({
      hub: { isOnline: () => true, dispatch: async () => ({}) as never },
      orgId: 'o1',
      nodeId: 'mac-2',
      alreadyInSwarm: true,
      foreignSwarm: () => FOREIGN_SWARM_DETAIL,
    });
    expect(out).toEqual({ action: 'noop', reason: FOREIGN_SWARM_DETAIL });
    expect(swarmOrchestrationStatus('mac-2')).toMatchObject({ state: 'failed', fix: FOREIGN_SWARM_FIX });
  });

  it('a node already in THIS swarm stays a plain no-op', async () => {
    const out = await orchestrateSwarmMembership({
      hub: { isOnline: () => true, dispatch: async () => ({}) as never },
      orgId: 'o1',
      nodeId: 'ok-1',
      alreadyInSwarm: true,
      foreignSwarm: () => null,
    });
    expect(out.action).toBe('noop');
    expect(swarmOrchestrationStatus('ok-1')).toBeNull();
  });
});
