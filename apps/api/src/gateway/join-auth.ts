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
  if (token.expiresAt && token.expiresAt.getTime() < now) {
    return { kind: 'reject', code: 'unauthorized', reason: 'invalid join token' };
  }
  if (token.maxUses != null && token.uses >= token.maxUses) {
    return { kind: 'reject', code: 'forbidden', reason: 'token exhausted' };
  }
  return { kind: 'enroll' };
}
