import { describe, expect, it } from 'bun:test';
import { decideLeaseWrite, type ControllerLeaseRecord } from './controllerService';
import { MeshControlStatus } from './mesh';
import {
  MESH_LEASE,
  MeshControlLeaseView,
  meshLeaseOutcome,
  meshLeaseStep,
  meshMayReplicate,
  observeMeshLease,
  replicaFenceAt,
  type MeshLeaseObservation,
} from './mesh-control-lease';

const lease = (holder: string, epoch: number, extra: Partial<ControllerLeaseRecord> = {}): ControllerLeaseRecord => ({
  holder,
  node: holder,
  hostname: `host-${holder}`,
  epoch,
  renewedAt: 1_000 + epoch,
  ttlMs: MESH_LEASE.ttlMs,
  ...extra,
});
const step = (record: ControllerLeaseRecord | null, opts: { self?: string; intent?: boolean; obs?: MeshLeaseObservation | null; now?: number } = {}) =>
  meshLeaseStep({ read: { ok: true, record }, self: opts.self ?? 'A', intent: opts.intent ?? false, obs: opts.obs ?? null, now: opts.now ?? 0 });

describe('the mesh control-plane lease: what a node with a spec does', () => {
  it('takes a lease nobody has (a first install, an upgrade) and renews its own', () => {
    expect(step(null)).toEqual({ do: 'acquire', expect: null, why: 'free' });
    expect(step(lease('A', 3))).toEqual({ do: 'renew', epoch: 3 });
    expect(step(lease('A', 3, { released: true }))).toMatchObject({ do: 'acquire', why: 'released' });
  });

  it('a returning old node (another holds it, no intent) fences, live or released', () => {
    expect(step(lease('B', 4))).toMatchObject({ do: 'fence', why: 'the lease is held by host-B (epoch 4): this node is no longer the control plane' });
    expect(step(lease('B', 4, { released: true }))).toMatchObject({ do: 'fence' });
    expect(meshMayReplicate({ state: 'lost', lastOkSentAt: 0, managers: 3 }, 0)).toBe(false);
  });

  it("a move target waits out the old holder's write for a full TTL, then takes over", () => {
    const old = lease('A', 4);
    const obs = observeMeshLease(null, old, 100);
    expect(step(old, { self: 'B', intent: true, obs, now: 100 + 59_999 })).toMatchObject({ do: 'wait', waitMs: 1 });
    expect(step(old, { self: 'B', intent: true, obs, now: 100 + MESH_LEASE.ttlMs })).toEqual({ do: 'acquire', expect: old, why: 'expired' });
    // A renewal is a new write: the clock starts again.
    const renewed = { ...old, renewedAt: old.renewedAt + 10_000 };
    const obs2 = observeMeshLease(obs, renewed, 100 + 59_000);
    expect(obs2.firstSeenAt).toBe(100 + 59_000);
    expect(step(renewed, { self: 'B', intent: true, obs: obs2, now: 100 + 61_000 })).toMatchObject({ do: 'wait' });
    expect(observeMeshLease(obs, { ...old }, 5_000)).toBe(obs);
    // A clean move: the old holder released it, take it at once.
    expect(step(lease('A', 4, { released: true }), { self: 'B', intent: true })).toMatchObject({ do: 'acquire', why: 'released' });
  });

  it('no answer from raft does nothing (never stops NetBird: the swarm may need it to regain quorum)', () => {
    expect(meshLeaseStep({ read: { ok: false, why: 'the swarm does not have a leader' }, self: 'A', intent: false, obs: null, now: 0 })).toEqual({
      do: 'nothing',
      why: 'the swarm does not have a leader',
    });
  });
});

describe('what a write proves', () => {
  it('only another live holder is a loss', () => {
    const live = lease('B', 5);
    const next = decideLeaseWrite(live, { kind: 'lease.renew', holder: 'A', node: 'A', ttlMs: MESH_LEASE.ttlMs, epoch: 4 }, 2_000).result;
    expect(meshLeaseOutcome(next, 'A')).toEqual({ kind: 'lost', lease: live });
    const ours = decideLeaseWrite(lease('A', 4), { kind: 'lease.renew', holder: 'A', node: 'A', ttlMs: MESH_LEASE.ttlMs, epoch: 4 }, 2_000).result;
    expect(meshLeaseOutcome(ours, 'A')).toMatchObject({ kind: 'held', lease: { holder: 'A', epoch: 4, renewedAt: 2_000 } });
    expect(meshLeaseOutcome({ ok: false, lease: lease('A', 4), reason: 'conflict' }, 'A')).toEqual({ kind: 'retry' });
    expect(meshLeaseOutcome({ ok: false, lease: null, reason: 'lost' }, 'A')).toEqual({ kind: 'retry' });
    expect(meshLeaseOutcome(null, 'A')).toEqual({ kind: 'retry' });
  });
});

describe('Litestream ships only inside the fence window', () => {
  it('stops TTL − margin after the last renewal was sent, before any challenger may start', () => {
    const t0 = 50_000;
    expect(replicaFenceAt(t0)).toBe(t0 + 52_000);
    expect(meshMayReplicate({ state: 'held', lastOkSentAt: t0, managers: 3 }, t0 + 51_999)).toBe(true);
    expect(meshMayReplicate({ state: 'silent', lastOkSentAt: t0, managers: 3 }, t0 + 52_000)).toBe(false);
    expect(meshMayReplicate({ state: 'silent', lastOkSentAt: t0, managers: null }, t0 + 52_000)).toBe(false);
    // The challenger first sees that write no earlier than t0, and waits a full TTL.
    const earliestTakeover = t0 + MESH_LEASE.ttlMs;
    expect(earliestTakeover - replicaFenceAt(t0)).toBe(MESH_LEASE.marginMs);
  });

  it('single manager: nobody else can hold it, so silence keeps replicating; never confirmed never ships', () => {
    expect(meshMayReplicate({ state: 'silent', lastOkSentAt: 0, managers: 1 }, 10 * 60_000)).toBe(true);
    expect(meshMayReplicate({ state: 'silent', lastOkSentAt: null, managers: 1 }, 0)).toBe(false);
    expect(meshMayReplicate({ state: 'waiting', lastOkSentAt: 0, managers: 1 }, 0)).toBe(false);
    expect(meshMayReplicate({ state: 'unleased', lastOkSentAt: null, managers: null }, 0)).toBe(true);
  });
});

describe('wire: meshState.control.lease (additive)', () => {
  it('parses with defaults; older agents omit it; unknown states are rejected', () => {
    const base = { running: true, healthy: true };
    expect(MeshControlStatus.parse(base).lease).toBeUndefined();
    const st = MeshControlStatus.parse({ ...base, lease: { state: 'held', epoch: 7, holderNode: 'n1' } });
    expect(st.lease).toEqual({ state: 'held', epoch: 7, holderNode: 'n1', replicate: false });
    expect(MeshControlLeaseView.safeParse({ state: 'stolen' }).success).toBe(false);
  });
});
