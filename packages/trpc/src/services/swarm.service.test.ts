import { describe, expect, it, beforeAll } from 'bun:test';

beforeAll(() => {
  // The vault encrypts the stored Docker join tokens; provide a key for tests.
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-swarm-service';
});

import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import {
  orchestrateSwarmMembership,
  type SwarmConfigRow,
  type SwarmDb,
  type SwarmHub,
} from './swarm.service';

interface DispatchCall {
  nodeId: string;
  payload: Record<string, unknown>;
}

function makeHub(online: boolean, result: unknown): { hub: SwarmHub; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const hub: SwarmHub = {
    isOnline: () => online,
    dispatch: async (nodeId, _cmd, payload) => {
      calls.push({ nodeId, payload: payload as Record<string, unknown> });
      return result as never;
    },
  };
  return { hub, calls };
}

function makeDb(initial: SwarmConfigRow | null): {
  db: SwarmDb;
  rows: Map<string, SwarmConfigRow>;
  nodeUpdates: { id: string; data: unknown }[];
} {
  const rows = new Map<string, SwarmConfigRow>();
  if (initial) rows.set(initial.orgId, initial);
  const nodeUpdates: { id: string; data: unknown }[] = [];
  const db: SwarmDb = {
    swarmConfig: {
      findUnique: async ({ where }) => rows.get(where.orgId) ?? null,
      upsert: async ({ where, create, update }) => {
        const existing = rows.get(where.orgId);
        const next = existing ? { ...existing, ...update } : create;
        rows.set(where.orgId, next);
        return next;
      },
    },
    node: {
      update: async ({ where, data }) => {
        nodeUpdates.push({ id: where.id, data });
        return undefined;
      },
    },
  };
  return { db, rows, nodeUpdates };
}

describe('orchestrateSwarmMembership', () => {
  it('no-ops when the node is already in a swarm', async () => {
    const { hub, calls } = makeHub(true, {});
    const { db } = makeDb(null);
    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n1', alreadyInSwarm: true });
    expect(out.action).toBe('noop');
    expect(calls).toHaveLength(0);
  });

  it('no-ops when the node is offline', async () => {
    const { hub, calls } = makeHub(false, {});
    const { db } = makeDb(null);
    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n1' });
    expect(out.action).toBe('noop');
    expect(calls).toHaveLength(0);
  });

  it('initialises the swarm for the first node and stores encrypted tokens', async () => {
    const { hub, calls } = makeHub(true, {
      mode: 'init',
      swarmNodeId: 'swarm-node-1',
      managerAddr: '10.0.0.2:2377',
      joinTokens: { worker: 'SWMTKN-worker', manager: 'SWMTKN-manager' },
    });
    const { db, rows, nodeUpdates } = makeDb(null);

    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n1' });

    expect(out).toEqual({ action: 'init', swarmNodeId: 'swarm-node-1' });
    expect(calls[0]?.payload.mode).toBe('init');

    const row = rows.get('o1')!;
    expect(row.swarmId).toBe('swarm-node-1');
    expect(row.managerNodeId).toBe('n1');
    expect(row.managerAddr).toBe('10.0.0.2:2377');
    // Stored encrypted, never plaintext, recoverable to the original token.
    expect(row.workerJoinTokenEnc).not.toContain('SWMTKN-worker');
    expect(decryptSecret(row.workerJoinTokenEnc!)).toBe('SWMTKN-worker');
    expect(decryptSecret(row.managerJoinTokenEnc!)).toBe('SWMTKN-manager');

    expect(nodeUpdates[0]).toEqual({ id: 'n1', data: { swarmNodeId: 'swarm-node-1', role: 'MANAGER' } });
  });

  it('joins a later node as a worker using the stored worker token', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: '10.0.0.2:2377',
      workerJoinTokenEnc: encryptFixture('SWMTKN-worker'),
      managerJoinTokenEnc: encryptFixture('SWMTKN-manager'),
    };
    const { hub, calls } = makeHub(true, { mode: 'join', swarmNodeId: 'swarm-node-2' });
    const { db, nodeUpdates } = makeDb(seed);

    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n2' });

    expect(out).toEqual({ action: 'join', role: 'worker', swarmNodeId: 'swarm-node-2' });
    const p = calls[0]!.payload;
    expect(p.mode).toBe('join');
    expect(p.role).toBe('worker');
    expect(p.managerAddr).toBe('10.0.0.2:2377');
    expect(p.joinToken).toBe('SWMTKN-worker'); // decrypted just-in-time for dispatch
    expect(nodeUpdates[0]).toEqual({ id: 'n2', data: { swarmNodeId: 'swarm-node-2', role: 'WORKER' } });
  });

  it('joins as a manager when role-hinted, using the manager token', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: '10.0.0.2:2377',
      workerJoinTokenEnc: encryptFixture('SWMTKN-worker'),
      managerJoinTokenEnc: encryptFixture('SWMTKN-manager'),
    };
    const { hub, calls } = makeHub(true, { mode: 'join', swarmNodeId: 'swarm-node-3' });
    const { db } = makeDb(seed);

    const out = await orchestrateSwarmMembership({
      db,
      hub,
      orgId: 'o1',
      nodeId: 'n3',
      roleHint: 'manager',
    });

    expect(out).toEqual({ action: 'join', role: 'manager', swarmNodeId: 'swarm-node-3' });
    expect(calls[0]!.payload.joinToken).toBe('SWMTKN-manager');
  });

  it('runs standalone (no-op) when a swarm exists but no token/addr is stored', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: null,
      workerJoinTokenEnc: null,
      managerJoinTokenEnc: null,
    };
    const { hub, calls } = makeHub(true, {});
    const { db } = makeDb(seed);

    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n2' });
    expect(out.action).toBe('noop');
    expect(calls).toHaveLength(0);
  });
});

// Use the real vault so the decrypt-on-dispatch path is exercised end to end.
function encryptFixture(plain: string): string {
  return encryptSecret(plain);
}
