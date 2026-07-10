import { describe, expect, it } from 'bun:test';
import { decideJoinAuth, type JoinTokenFacts, type OwnerNodeFacts } from './join-auth';

const NOW = 1_000_000_000_000;
const token = (over: Partial<JoinTokenFacts> = {}): JoinTokenFacts => ({
  id: 'tok-1',
  revokedAt: null,
  expiresAt: null,
  maxUses: 1,
  uses: 0,
  ...over,
});
const owner = (over: Partial<OwnerNodeFacts> = {}): OwnerNodeFacts => ({ id: 'node-1', joinTokenId: 'tok-1', ...over });

describe('decideJoinAuth', () => {
  it('rejects an unknown token', () => {
    expect(decideJoinAuth(null, null, NOW)).toEqual({ kind: 'reject', code: 'unauthorized', reason: 'invalid join token' });
  });

  it('revocation is the kill switch — rejects even the bound node (self-heal cannot bypass it)', () => {
    const decision = decideJoinAuth(token({ revokedAt: new Date(NOW - 1) }), owner(), NOW);
    expect(decision).toEqual({ kind: 'reject', code: 'unauthorized', reason: 'invalid join token' });
  });

  it('enrolls on a fresh unused token with no owner', () => {
    expect(decideJoinAuth(token(), null, NOW)).toEqual({ kind: 'enroll' });
  });

  it('re-adopts when the token is bound to the existing node — even though it is single-use-consumed', () => {
    const consumed = token({ maxUses: 1, uses: 1 });
    expect(decideJoinAuth(consumed, owner({ joinTokenId: 'tok-1' }), NOW)).toEqual({ kind: 'readopt', nodeId: 'node-1' });
  });

  it('re-adopts a bound node even after expiry (durable fallback credential)', () => {
    const expired = token({ expiresAt: new Date(NOW - 1), uses: 1 });
    expect(decideJoinAuth(expired, owner(), NOW)).toEqual({ kind: 'readopt', nodeId: 'node-1' });
  });

  it('does NOT re-adopt when the hostname is owned by a node bound to a DIFFERENT token', () => {
    // Hostname reuse with a newer token → treated as a fresh enrollment,
    // subject to the full policy.
    const fresh = token({ id: 'tok-2', uses: 0, maxUses: 1 });
    expect(decideJoinAuth(fresh, owner({ joinTokenId: 'tok-1' }), NOW)).toEqual({ kind: 'enroll' });
  });

  it('rejects an exhausted token for a NEW (unbound) enrollment', () => {
    const exhausted = token({ maxUses: 1, uses: 1 });
    expect(decideJoinAuth(exhausted, null, NOW)).toEqual({ kind: 'reject', code: 'forbidden', reason: 'token exhausted' });
  });

  it('rejects an expired token for a new enrollment', () => {
    const expired = token({ expiresAt: new Date(NOW - 1) });
    expect(decideJoinAuth(expired, null, NOW)).toEqual({ kind: 'reject', code: 'unauthorized', reason: 'invalid join token' });
  });

  it('allows a multi-use token to enroll repeatedly until the cap', () => {
    expect(decideJoinAuth(token({ maxUses: 100, uses: 50 }), null, NOW)).toEqual({ kind: 'enroll' });
    expect(decideJoinAuth(token({ maxUses: 100, uses: 100 }), null, NOW).kind).toBe('reject');
  });
});
