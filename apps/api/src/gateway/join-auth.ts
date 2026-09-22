/**
 * Pure decision for how a presented join token authenticates a registering
 * agent. Extracted from handleRegister so the security-critical branching
 * (revocation kill switch, node-bound re-adoption, enrollment policy) is
 * unit-testable in isolation.
 */

export interface JoinTokenFacts {
  id: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
}

/** The existing node for this org+hostname, if any (the re-adoption target). */
export interface OwnerNodeFacts {
  id: string;
  joinTokenId: string | null;
}

// WebSocket close reasons are capped at 123 bytes — keep these short + ASCII.
export const JOIN_TOKEN_EXPIRED_REASON = 'join token expired - mint a fresh one in the dashboard (node > Repair) and re-run';
export const JOIN_TOKEN_EXHAUSTED_REASON = 'token exhausted - mint a fresh join token in the dashboard and re-run';

export type JoinAuthDecision =
  | { kind: 'reject'; code: 'unauthorized' | 'forbidden'; reason: string }
  | { kind: 'readopt'; nodeId: string }
  | { kind: 'enroll' };

/**
 * Decide the outcome. `now` is injectable for deterministic tests.
 *
 * Order matters:
 *   1. Revocation (or unknown token) rejects everything — the kill switch.
 *   2. If the token is bound to the existing node for this hostname →
 *      re-adopt, regardless of expiry/uses (it re-authenticates a known box,
 *      it cannot enroll anything new).
 *   3. Otherwise it's a fresh enrollment and the full expiry + uses-cap
 *      policy applies.
 */
export function decideJoinAuth(
  token: JoinTokenFacts | null,
  owner: OwnerNodeFacts | null,
  now = Date.now(),
): JoinAuthDecision {
  if (!token || token.revokedAt) {
    return { kind: 'reject', code: 'unauthorized', reason: 'invalid join token' };
  }
  if (owner && owner.joinTokenId === token.id) {
    return { kind: 'readopt', nodeId: owner.id };
  }
  // Actionable reasons (surfaced by `swarmy-agent doctor` + the install log):
  // the holder already has the token string, so naming expiry/exhaustion leaks
  // nothing — and "invalid" sent operators hunting for a URL bug instead of
  // minting a fresh token.
  if (token.expiresAt && token.expiresAt.getTime() < now) {
    return { kind: 'reject', code: 'unauthorized', reason: JOIN_TOKEN_EXPIRED_REASON };
  }
  if (token.maxUses != null && token.uses >= token.maxUses) {
    return { kind: 'reject', code: 'forbidden', reason: JOIN_TOKEN_EXHAUSTED_REASON };
  }
  return { kind: 'enroll' };
}
