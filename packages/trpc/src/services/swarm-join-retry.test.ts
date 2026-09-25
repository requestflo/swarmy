import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-swarm-service';
});

import {
  SWARM_JOIN_BACKOFF_MS,
  SWARM_JOIN_MAX_ATTEMPTS,
  clearSwarmJoinRetries,
  nextSwarmJoinAttemptAt,
  orchestrateSwarmMembership,
  pendingSwarmJoins,
  retryPendingSwarmJoins,
  swarmOrchestrationStatus,
  type SwarmHub,
} from './swarm.service';

/** A live manager m1 hands out tokens; the new node's join fails `failures` times, then works. */
function world(failures: number, opts: { online?: () => boolean; state?: () => string | undefined } = {}) {
  let joins = 0;
  const hub: SwarmHub = {
    isOnline: opts.online ?? (() => true),
    swarmStateFor: opts.state,
    dispatch: async (nodeId, _cmd, payload) => {
      const p = payload as { mode: string; refreshOnly?: boolean };
      if (nodeId === 'm1' && p.refreshOnly) {
        return { mode: 'init', swarmNodeId: 'sw', managerAddr: '100.64.0.1:2377', joinTokens: { worker: 'W', manager: 'M' } } as never;
      }
      joins += 1;
      if (joins <= failures) throw new Error('command timeout');
      return { mode: 'join', swarmNodeId: 'sw-new' } as never;
    },
  };
  const args = {
    hub,
    orgId: 'o1',
    nodeId: 'new',
    peers: () => [{ nodeId: 'm1', isManager: true, swarmState: 'active' as const }],
  };
  return { hub, args, joins: () => joins };
}

beforeEach(() => clearSwarmJoinRetries());

describe('swarm.join retry (a slow first path must not strand a node)', () => {
  it('backoff schedule is bounded', () => {
    expect(nextSwarmJoinAttemptAt(1, 0)).toBe(SWARM_JOIN_BACKOFF_MS[0]);
    expect(nextSwarmJoinAttemptAt(2, 1000)).toBe(1000 + SWARM_JOIN_BACKOFF_MS[1]);
    expect(nextSwarmJoinAttemptAt(SWARM_JOIN_MAX_ATTEMPTS - 1, 0)).toBe(SWARM_JOIN_BACKOFF_MS.at(-1)!);
    expect(nextSwarmJoinAttemptAt(SWARM_JOIN_MAX_ATTEMPTS, 0)).toBeNull();
  });

  it('a join that times out on register is retried by the tick after the backoff, and then succeeds', async () => {
    const w = world(1);
    await expect(orchestrateSwarmMembership(w.args)).rejects.toThrow('command timeout');
    const [p] = pendingSwarmJoins();
    expect(p).toMatchObject({ nodeId: 'new', attempts: 1, lastError: 'command timeout' });
    expect(swarmOrchestrationStatus('new')?.detail).toMatch(/join attempt 1\/6 failed: command timeout — retrying in 15s/);

    // Not due yet: nothing is sent.
    expect((await retryPendingSwarmJoins(p!.nextAt - 1)).retried).toEqual([]);
    expect(w.joins()).toBe(1);

    const r = await retryPendingSwarmJoins(p!.nextAt);
    expect(r.retried).toEqual(['new']);
    expect(w.joins()).toBe(2);
    expect(pendingSwarmJoins()).toEqual([]);
    expect(swarmOrchestrationStatus('new')?.state).toBe('joined');
  });

  it('gives up after the bounded attempts with a clear reason on the node', async () => {
    const w = world(99);
    await orchestrateSwarmMembership(w.args).catch(() => undefined);
    for (let i = 0; i < SWARM_JOIN_MAX_ATTEMPTS + 2; i++) {
      const p = pendingSwarmJoins()[0];
      if (!p) break;
      await retryPendingSwarmJoins(p.nextAt);
    }
    expect(w.joins()).toBe(SWARM_JOIN_MAX_ATTEMPTS);
    expect(pendingSwarmJoins()).toEqual([]);
    const st = swarmOrchestrationStatus('new');
    expect(st?.state).toBe('failed');
    expect(st?.detail).toMatch(/^couldn't join the cluster: command timeout \(gave up after 6 attempts/);
  });

  it('an offline node waits (no dispatch into the void); a node that joined anyway is cleared', async () => {
    let online = true;
    let state: string | undefined;
    const w = world(99, { online: () => online, state: () => state });
    await orchestrateSwarmMembership(w.args).catch(() => undefined);
    const p = pendingSwarmJoins()[0]!;
    online = false;
    expect((await retryPendingSwarmJoins(p.nextAt)).skipped).toEqual(['new']);
    expect(w.joins()).toBe(1);
    state = 'active';
    expect((await retryPendingSwarmJoins(p.nextAt)).joined).toEqual(['new']);
    expect(pendingSwarmJoins()).toEqual([]);
  });

  it('a re-register starts the count over', async () => {
    const w = world(99);
    await orchestrateSwarmMembership(w.args).catch(() => undefined);
    await retryPendingSwarmJoins(pendingSwarmJoins()[0]!.nextAt);
    expect(pendingSwarmJoins()[0]!.attempts).toBe(2);
    await orchestrateSwarmMembership(w.args).catch(() => undefined); // the agent reconnected
    expect(pendingSwarmJoins()[0]!.attempts).toBe(1);
  });
});
