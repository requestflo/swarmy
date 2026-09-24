import { describe, expect, it } from 'bun:test';
import { decideLeaseWrite, type ControllerLeaseRecord } from '@swarmy/core/protocol';
import {
  LEASE_FENCE_MARGIN_MS,
  LEASE_TTL_MS,
  fenceDeadline,
  minEpoch,
  mustFence,
  observe,
  stillHeld,
  takeoverDecision,
} from './lease';

const rec = (over: Partial<ControllerLeaseRecord> = {}): ControllerLeaseRecord => ({
  holder: 'task-a',
  node: 'node-a',
  hostname: 'a',
  epoch: 4,
  renewedAt: 1_000,
  ttlMs: LEASE_TTL_MS,
  ...over,
});
const me = { holder: 'task-b', node: 'node-b' };

describe('lease expiry (observation-based)', () => {
  it('a free lease is taken at once', () => {
    expect(takeoverDecision(observe(null, null, 0), me, 0)).toEqual({ take: true, expect: null, why: 'free' });
  });

  it('a released lease is taken at once, expecting the released record', () => {
    const r = rec({ released: true });
    expect(takeoverDecision(observe(null, r, 0), me, 0)).toMatchObject({ take: true, expect: r, why: 'released' });
  });

  it('a live lease on another node is NOT taken before a full TTL of observed silence', () => {
    const o = observe(null, rec(), 100);
    const d = takeoverDecision(o, me, 100 + LEASE_TTL_MS - 1);
    expect(d.take).toBe(false);
    if (!d.take) expect(d.waitMs).toBe(1);
  });

  it('a lease unchanged for a full TTL is expired, and the takeover expects exactly that write', () => {
    const r = rec();
    const o = observe(null, r, 100);
    expect(takeoverDecision(o, me, 100 + LEASE_TTL_MS)).toEqual({ take: true, expect: r, why: 'expired' });
  });

  it('a renewal restarts the watch (the holder is alive)', () => {
    let o = observe(null, rec({ renewedAt: 1_000 }), 0);
    o = observe(o, rec({ renewedAt: 11_000 }), 20_000);
    expect(o.firstSeenAt).toBe(20_000);
    expect(takeoverDecision(o, me, 20_000 + LEASE_TTL_MS - 1).take).toBe(false);
  });

  it('the same write seen again keeps the original watch start', () => {
    const o1 = observe(null, rec(), 0);
    const o2 = observe(o1, rec(), 5_000);
    expect(o2.firstSeenAt).toBe(0);
  });

  it('expiry does not compare clocks: a far-future renewedAt still only counts observed time', () => {
    const o = observe(null, rec({ renewedAt: 9_999_999_999_999 }), 0);
    expect(takeoverDecision(o, me, LEASE_TTL_MS).take).toBe(true);
    expect(takeoverDecision(o, me, LEASE_TTL_MS - 1).take).toBe(false);
  });

  it('a lease left by a task on OUR node is taken at once (stop-first: it is gone)', () => {
    const o = observe(null, rec({ node: 'node-b' }), 0);
    expect(takeoverDecision(o, me, 0)).toMatchObject({ take: true, why: 'same-node' });
  });
});

describe('holder fencing', () => {
  it('fences margin before the TTL, timed from when the last good renewal was SENT', () => {
    expect(fenceDeadline(1_000)).toBe(1_000 + LEASE_TTL_MS - LEASE_FENCE_MARGIN_MS);
    expect(mustFence(1_000 + LEASE_TTL_MS - LEASE_FENCE_MARGIN_MS - 1, 1_000)).toBe(false);
    expect(mustFence(1_000 + LEASE_TTL_MS - LEASE_FENCE_MARGIN_MS, 1_000)).toBe(true);
  });

  it('the old holder is always fenced before a challenger can take over', () => {
    // Holder sends its last good renewal at t=0; the challenger sees that write
    // no earlier than t=0 and needs a full TTL of silence after that.
    const lastSent = 0;
    const challengerFirstSees = 0;
    const takeoverAt = challengerFirstSees + LEASE_TTL_MS;
    expect(fenceDeadline(lastSent)).toBeLessThan(takeoverAt);
    expect(takeoverAt - fenceDeadline(lastSent)).toBe(LEASE_FENCE_MARGIN_MS);
  });

  it('a renewal answer naming another holder or epoch is not ours', () => {
    const self = { holder: 'task-a', node: 'node-a' };
    expect(stillHeld({ ok: true, lease: rec() }, self, 4)).toBe(true);
    expect(stillHeld({ ok: true, lease: rec({ epoch: 5 }) }, self, 4)).toBe(false);
    expect(stillHeld({ ok: true, lease: rec({ holder: 'task-z' }) }, self, 4)).toBe(false);
    expect(stillHeld({ ok: true, lease: rec({ released: true }) }, self, 4)).toBe(false);
    expect(stillHeld({ ok: false, lease: rec() }, self, 4)).toBe(false);
  });

  it('minEpoch never goes below anything seen', () => {
    expect(minEpoch(undefined, null, 3, 7)).toBe(7);
    expect(minEpoch()).toBe(0);
  });
});

describe('epoch fencing on the agent (decideLeaseWrite)', () => {
  const acquire = (over: Record<string, unknown> = {}) =>
    ({ kind: 'lease.acquire', holder: 'task-b', node: 'node-b', ttlMs: LEASE_TTL_MS, minEpoch: 0, ...over }) as const;

  it('acquire on an empty label starts at epoch 1', () => {
    const { next, result } = decideLeaseWrite(null, acquire(), 50);
    expect(result.ok).toBe(true);
    expect(next).toMatchObject({ holder: 'task-b', epoch: 1, renewedAt: 50 });
  });

  it('acquire bumps past both the live epoch and minEpoch', () => {
    expect(decideLeaseWrite(rec({ released: true, epoch: 4 }), acquire(), 0).next?.epoch).toBe(5);
    expect(decideLeaseWrite(null, acquire({ minEpoch: 9 }), 0).next?.epoch).toBe(10);
    // A `docker stack deploy` wiped the label: the floor keeps epochs moving forward.
    expect(decideLeaseWrite(null, acquire({ minEpoch: 4 }), 0).next?.epoch).toBe(5);
  });

  it('acquire refuses a live lease unless it is exactly the expected (stale) write', () => {
    const live = rec();
    expect(decideLeaseWrite(live, acquire(), 0).result).toMatchObject({ ok: false, reason: 'held' });
    expect(decideLeaseWrite(live, acquire({ expect: rec({ renewedAt: 999 }) }), 0).result).toMatchObject({ ok: false, reason: 'held' });
    const took = decideLeaseWrite(live, acquire({ expect: live }), 0);
    expect(took.result.ok).toBe(true);
    expect(took.next?.epoch).toBe(5);
  });

  it('renew keeps the epoch; a superseded holder cannot renew', () => {
    const renew = { kind: 'lease.renew', holder: 'task-a', node: 'node-a', ttlMs: LEASE_TTL_MS, epoch: 4 } as const;
    const ok = decideLeaseWrite(rec(), renew, 2_000);
    expect(ok.next).toMatchObject({ epoch: 4, renewedAt: 2_000 });
    expect(decideLeaseWrite(rec({ epoch: 5, holder: 'task-b' }), renew, 0).result).toMatchObject({ ok: false, reason: 'lost' });
    expect(decideLeaseWrite(rec({ epoch: 5 }), renew, 0).result).toMatchObject({ ok: false, reason: 'lost' });
    expect(decideLeaseWrite(rec({ released: true }), renew, 0).result).toMatchObject({ ok: false, reason: 'lost' });
    expect(decideLeaseWrite(null, renew, 0).result).toMatchObject({ ok: false, reason: 'lost' });
  });

  it('release marks ours released (epoch kept) and never touches someone else’s', () => {
    const release = { kind: 'lease.release', holder: 'task-a', epoch: 4 } as const;
    expect(decideLeaseWrite(rec(), release, 3).next).toMatchObject({ released: true, epoch: 4 });
    const other = decideLeaseWrite(rec({ holder: 'task-b', epoch: 5 }), release, 3);
    expect(other.next).toBeNull();
    expect(other.result.ok).toBe(true);
  });

  it('two challengers expecting the same stale write: only the CAS winner holds it (the loser re-reads a new epoch)', () => {
    const stale = rec();
    const b = decideLeaseWrite(stale, acquire({ expect: stale }), 10);
    // After B's write lands, C's identical request sees B's record, not the stale one.
    const c = decideLeaseWrite(b.next, acquire({ holder: 'task-c', node: 'node-c', expect: stale }), 11);
    expect(c.result).toMatchObject({ ok: false, reason: 'held' });
  });
});
