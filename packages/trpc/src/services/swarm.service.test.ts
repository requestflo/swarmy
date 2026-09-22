import { describe, expect, it, beforeAll } from 'bun:test';

beforeAll(() => {
  // The vault encrypts the stored Docker join tokens; provide a key for tests.
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-swarm-service';
});

import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import {
  MAX_DEFERS,
  orchestrateSwarmMembership,
  planAfterStoredJoinFailure,
  planSwarmMembership,
  swarmOrchestrationStatus,
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
} {
  const rows = new Map<string, SwarmConfigRow>();
  if (initial) rows.set(initial.orgId, initial);
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
  };
  return { db, rows };
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
    const { db, rows } = makeDb(null);

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
    // The node's swarm id + role are Docker truth now — no Node-row write to assert.
  });

  it('joins a later node as a worker using the stored worker token', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: '10.0.0.2:2377',
      workerJoinTokenEnc: encryptFixture('SWMTKN-worker'),
      managerJoinTokenEnc: encryptFixture('SWMTKN-manager'),
      unlockKeyEnc: null,
    };
    const { hub, calls } = makeHub(true, { mode: 'join', swarmNodeId: 'swarm-node-2' });
    const { db } = makeDb(seed);

    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n2' });

    expect(out).toEqual({ action: 'join', role: 'worker', swarmNodeId: 'swarm-node-2' });
    const p = calls[0]!.payload;
    expect(p.mode).toBe('join');
    expect(p.role).toBe('worker');
    expect(p.managerAddr).toBe('10.0.0.2:2377');
    expect(p.joinToken).toBe('SWMTKN-worker'); // decrypted just-in-time for dispatch
  });

  it('joins as a manager when role-hinted, using the manager token', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: '10.0.0.2:2377',
      workerJoinTokenEnc: encryptFixture('SWMTKN-worker'),
      managerJoinTokenEnc: encryptFixture('SWMTKN-manager'),
      unlockKeyEnc: null,
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

  it('re-elects (init) when a swarm is recorded but has no join material and no manager is live', async () => {
    const seed: SwarmConfigRow = {
      orgId: 'o1',
      swarmId: 'swarm-node-1',
      managerNodeId: 'n1',
      managerAddr: null,
      workerJoinTokenEnc: null,
      managerJoinTokenEnc: null,
      unlockKeyEnc: null,
    };
    const { hub, calls } = makeHub(true, {
      mode: 'init',
      swarmNodeId: 'swarm-node-2',
      managerAddr: '10.0.0.3:2377',
      joinTokens: { worker: 'W2', manager: 'M2' },
    });
    const { db, rows } = makeDb(seed);

    const out = await orchestrateSwarmMembership({ db, hub, orgId: 'o1', nodeId: 'n2' });
    expect(out).toEqual({ action: 'init', swarmNodeId: 'swarm-node-2', reelected: true });
    expect(calls[0]!.payload.mode).toBe('init');
    expect(rows.get('o1')!.managerNodeId).toBe('n2');
    expect(swarmOrchestrationStatus('n2')?.state).toBe('reelected');
  });
});

// ── Pure decision logic ──────────────────────────────────────────────────────

const FULL: SwarmConfigRow = {
  orgId: 'o1',
  swarmId: 'sw1',
  managerNodeId: 'mgr',
  managerAddr: '100.71.26.140:2377',
  workerJoinTokenEnc: 'enc-w',
  managerJoinTokenEnc: 'enc-m',
  unlockKeyEnc: null,
};
const base = { alreadyInSwarm: false, online: true, role: 'worker' as const, defers: 0 };

describe('planSwarmMembership', () => {
  it('noop when already in a swarm or offline', () => {
    expect(planSwarmMembership({ ...base, alreadyInSwarm: true, cfg: FULL, peers: [] }).kind).toBe('noop');
    expect(planSwarmMembership({ ...base, online: false, cfg: FULL, peers: [] }).kind).toBe('noop');
  });

  it('init (not a re-election) for the first node in an org', () => {
    expect(planSwarmMembership({ ...base, cfg: null, peers: [] })).toMatchObject({ kind: 'init', reelect: false });
  });

  it('a row without swarmId (e.g. autolock-created) never beats a live manager', () => {
    const plan = planSwarmMembership({
      ...base,
      cfg: { ...FULL, swarmId: null },
      peers: [{ nodeId: 'm2', isManager: true, swarmState: 'active' }],
    });
    expect(plan).toEqual({ kind: 'join-live', role: 'worker', managerNodeId: 'm2' });
  });

  it('worker rejoin with NO row but a live manager joins it — never a standalone init', () => {
    const plan = planSwarmMembership({
      ...base,
      cfg: null,
      peers: [
        { nodeId: 'w1', isManager: false, swarmState: 'active' },
        { nodeId: 'm1', isManager: true, swarmState: 'active' },
      ],
    });
    expect(plan.kind).toBe('join-live');
  });

  it('prefers the recorded manager among several live ones', () => {
    const plan = planSwarmMembership({
      ...base,
      cfg: FULL,
      peers: [
        { nodeId: 'm2', isManager: true, swarmState: 'active' },
        { nodeId: 'mgr', isManager: true, swarmState: 'active' },
      ],
    });
    expect(plan).toMatchObject({ kind: 'join-live', managerNodeId: 'mgr' });
  });

  it('a manager whose local swarm is not active is not live', () => {
    const plan = planSwarmMembership({
      ...base,
      cfg: FULL,
      peers: [{ nodeId: 'mgr', isManager: true, swarmState: 'pending' }],
    });
    expect(plan.kind).toBe('join-stored');
  });

  it('defers while connected peers have not reported their role, then decides', () => {
    const peers = [{ nodeId: 'x', isManager: undefined }];
    expect(planSwarmMembership({ ...base, cfg: null, peers }).kind).toBe('defer');
    expect(planSwarmMembership({ ...base, cfg: null, peers, defers: MAX_DEFERS }).kind).toBe('init');
  });

  it('stale row with no live manager tries the stored join first (manager agent may just be disconnected)', () => {
    const plan = planSwarmMembership({ ...base, cfg: FULL, peers: [] });
    expect(plan).toEqual({ kind: 'join-stored', role: 'worker', managerAddr: FULL.managerAddr!, tokenEnc: 'enc-w' });
  });

  it('uses the manager token when role-hinted manager', () => {
    const plan = planSwarmMembership({ ...base, role: 'manager', cfg: FULL, peers: [] });
    expect(plan).toMatchObject({ kind: 'join-stored', tokenEnc: 'enc-m' });
  });
});

describe('planAfterStoredJoinFailure', () => {
  it('re-elects when no manager is live', () => {
    expect(planAfterStoredJoinFailure('worker', [])).toMatchObject({ kind: 'init', reelect: true });
  });
  it('joins a manager that appeared meanwhile instead of splitting the swarm', () => {
    expect(
      planAfterStoredJoinFailure('worker', [{ nodeId: 'm9', isManager: true, swarmState: 'active' }]),
    ).toEqual({ kind: 'join-live', role: 'worker', managerNodeId: 'm9' });
  });
});

// ── Orchestration scenarios (stubbed hub/db) ─────────────────────────────────

function scriptedHub(handler: (nodeId: string, payload: Record<string, unknown>) => unknown): {
  hub: SwarmHub;
  calls: DispatchCall[];
} {
  const calls: DispatchCall[] = [];
  const hub: SwarmHub = {
    isOnline: () => true,
    dispatch: async (nodeId, _cmd, payload) => {
      calls.push({ nodeId, payload: payload as Record<string, unknown> });
      return (await handler(nodeId, payload as Record<string, unknown>)) as never;
    },
  };
  return { hub, calls };
}

describe('orchestrateSwarmMembership — self-healing', () => {
  it('dead recorded manager: join times out → re-elect, clear stale row, pull in stranded peers', async () => {
    const seed = { ...FULL, workerJoinTokenEnc: encryptFixture('OLD-W'), managerJoinTokenEnc: encryptFixture('OLD-M') };
    const { db, rows } = makeDb(seed);
    const { hub, calls } = scriptedHub((nodeId, p) => {
      if (p.mode === 'join' && p.managerAddr === FULL.managerAddr) throw new Error('context deadline exceeded');
      if (p.mode === 'init' && nodeId === 'new')
        return { mode: 'init', swarmNodeId: 'sw-new', managerAddr: '10.0.0.9:2377', joinTokens: { worker: 'NEW-W', manager: 'NEW-M' } };
      return { mode: 'join', swarmNodeId: `sw-${nodeId}` };
    });
    const events: string[] = [];
    const out = await orchestrateSwarmMembership({
      db,
      hub,
      orgId: 'o1',
      nodeId: 'new',
      peers: () => [{ nodeId: 'stranded', isManager: false, swarmState: 'inactive' }],
      onEvent: (e) => events.push(e.state),
    });
    expect(out).toEqual({ action: 'init', swarmNodeId: 'sw-new', reelected: true });
    const row = rows.get('o1')!;
    expect(row.managerAddr).toBe('10.0.0.9:2377');
    expect(row.managerNodeId).toBe('new');
    expect(decryptSecret(row.workerJoinTokenEnc!)).toBe('NEW-W');
    expect(events).toContain('reelected');
    expect(swarmOrchestrationStatus('new')?.detail).toContain('context deadline exceeded');
    await Bun.sleep(0);
    const peerJoin = calls.find((c) => c.nodeId === 'stranded');
    expect(peerJoin?.payload).toMatchObject({ mode: 'join', joinToken: 'NEW-W', managerAddr: '10.0.0.9:2377' });
  });

  it('live manager: refreshes tokens/addr from it (healing a stale row) and joins — never inits', async () => {
    const { db, rows } = makeDb({ ...FULL, workerJoinTokenEnc: encryptFixture('STALE') });
    const { hub, calls } = scriptedHub((nodeId, p) => {
      if (nodeId === 'm1' && p.refreshOnly)
        return { mode: 'init', swarmNodeId: 'sw-m1', managerAddr: '100.71.224.116:2377', joinTokens: { worker: 'FRESH-W', manager: 'FRESH-M' } };
      if (p.mode === 'join') return { mode: 'join', swarmNodeId: 'sw-w2' };
      throw new Error(`unexpected ${JSON.stringify(p)}`);
    });
    const out = await orchestrateSwarmMembership({
      db,
      hub,
      orgId: 'o1',
      nodeId: 'w2',
      peers: () => [{ nodeId: 'm1', isManager: true, swarmState: 'active' }],
    });
    expect(out).toEqual({ action: 'join', role: 'worker', swarmNodeId: 'sw-w2' });
    expect(calls.some((c) => c.nodeId === 'w2' && c.payload.mode === 'init')).toBe(false);
    expect(calls[1]!.payload).toMatchObject({ joinToken: 'FRESH-W', managerAddr: '100.71.224.116:2377' });
    expect(rows.get('o1')!.managerAddr).toBe('100.71.224.116:2377');
    expect(rows.get('o1')!.managerNodeId).toBe('m1');
  });

  it('surfaces a failed join via a live manager (no re-election beside a live manager)', async () => {
    const { db } = makeDb(FULL);
    const { hub } = scriptedHub((nodeId, p) => {
      if (p.refreshOnly) return { mode: 'init', swarmNodeId: 's', managerAddr: '1.2.3.4:2377', joinTokens: { worker: 'W', manager: 'M' } };
      throw new Error('rpc error: connection refused');
    });
    await expect(
      orchestrateSwarmMembership({
        db,
        hub,
        orgId: 'o1',
        nodeId: 'w3',
        peers: () => [{ nodeId: 'm1', isManager: true, swarmState: 'active' }],
      }),
    ).rejects.toThrow('connection refused');
    expect(swarmOrchestrationStatus('w3')).toMatchObject({ state: 'failed' });
  });

  it('waits for unreported peers, then joins the manager once it reports', async () => {
    const { db } = makeDb(null);
    let reported = false;
    const { hub, calls } = scriptedHub((_n, p) =>
      p.refreshOnly
        ? { mode: 'init', swarmNodeId: 's', managerAddr: '1.2.3.4:2377', joinTokens: { worker: 'W', manager: 'M' } }
        : { mode: 'join', swarmNodeId: 'sw-w4' },
    );
    const out = await orchestrateSwarmMembership({
      db,
      hub,
      orgId: 'o1',
      nodeId: 'w4',
      deferDelayMs: 1,
      peers: () => {
        const p = [{ nodeId: 'm1', isManager: reported ? true : undefined, swarmState: 'active' as const }];
        reported = true;
        return p;
      },
    });
    expect(out.action).toBe('join');
    expect(calls.every((c) => !(c.nodeId === 'w4' && c.payload.mode === 'init'))).toBe(true);
  });
});

// Use the real vault so the decrypt-on-dispatch path is exercised end to end.
function encryptFixture(plain: string): string {
  return encryptSecret(plain);
}
