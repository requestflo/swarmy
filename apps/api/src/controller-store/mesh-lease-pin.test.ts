import { describe, expect, it } from 'bun:test';
import { MESH_LEASE, meshLeaseStep, observeMeshLease, replicaFenceAt } from '@swarmy/core/protocol';
import { LEASE_FENCE_MARGIN_MS, LEASE_RENEW_EVERY_MS, LEASE_RETRY_MS, LEASE_TTL_MS, fenceDeadline, observe, takeoverDecision } from './lease';

/**
 * The mesh control plane's lease (`@swarmy/core/protocol` mesh-control-lease.ts)
 * is this lease's mechanism, run by an agent instead of the controller. The
 * agent can't import this app, so the numbers are copied there; this pins them
 * (like fence-drill.ts) and checks the two agree on takeover and fencing.
 */
describe('the mesh control-plane lease uses the controller store lease', () => {
  it('has the same TTL, renew interval, retry and fence margin', () => {
    expect(MESH_LEASE).toEqual({ ttlMs: LEASE_TTL_MS, renewEveryMs: LEASE_RENEW_EVERY_MS, retryMs: LEASE_RETRY_MS, marginMs: LEASE_FENCE_MARGIN_MS });
  });

  it('fences at the same deadline', () => {
    expect(replicaFenceAt(12_345)).toBe(fenceDeadline(12_345));
  });

  it('takes over a live lease at the same moment (a full TTL of the same write, on our own clock)', () => {
    const r = { holder: 'old', node: 'old', epoch: 4, renewedAt: 9, ttlMs: LEASE_TTL_MS };
    const ctl = observe(null, r, 1_000);
    const mesh = observeMeshLease(null, r, 1_000);
    for (const now of [1_000, 60_999, 61_000, 90_000]) {
      const a = takeoverDecision(ctl, { holder: 'new', node: 'new' }, now).take;
      const b = meshLeaseStep({ read: { ok: true, record: r }, self: 'new', intent: true, obs: mesh, now }).do === 'acquire';
      expect(b).toBe(a);
    }
  });
});
