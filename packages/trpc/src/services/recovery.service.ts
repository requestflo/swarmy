/**
 * Recovery beacon (self-healing epic) — the device-pairing-style approval flow
 * for a node that lost EVERY credential: its session file is gone AND its
 * env-file join token is revoked/unusable. The agent posts a claim and prints
 * a fingerprint in its journal; the operator compares that fingerprint in the
 * dashboard and approves; the agent's next poll receives a freshly-minted
 * session credential, once, and reconnects as its old self.
 *
 * Trust model (same as SSH host keys): the claim itself is UNAUTHENTICATED —
 * anyone can post one. The security lives in (1) the human comparing the
 * fingerprint shown on the machine with the one in the dashboard, (2) claims
 * only ever attaching to an EXISTING node (never enrolling), (3) the claim
 * secret binding approval delivery to the original claimant, (4) 15-minute
 * expiry and single pending claim per hostname, (5) one-shot delivery with
 * the credential wiped after handoff.
 */
import { randomBytes } from 'node:crypto';
import { SESSION_TOKEN_PREFIX } from '@swarmy/core';
import { decryptSecret, encryptSecret, hashToken } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { notFound } from '../errors';

export const CLAIM_TTL_MS = 15 * 60 * 1000;

/** Short human-comparable code from the claim hash: "3F2A-9C10". */
export function claimFingerprint(claimHash: string): string {
  return `${claimHash.slice(0, 4)}-${claimHash.slice(4, 8)}`.toUpperCase();
}

// ── agent-facing (unauthenticated HTTP, claim-secret-bound) ─────────────────

export interface SubmitClaimResult {
  accepted: boolean;
  claimId?: string;
  fingerprint?: string;
  expiresAt?: string;
}

/**
 * Register a recovery claim. Only hostnames matching EXACTLY ONE existing
 * node anywhere are persisted (recovery re-authenticates known machines —
 * it can never enroll). The response is deliberately identical in shape for
 * unknown hostnames so this endpoint can't be used to enumerate node names.
 */
export async function submitRecoveryClaim(
  db: DB,
  input: { hostname: string; claimHash: string },
): Promise<SubmitClaimResult> {
  const hostname = input.hostname.slice(0, 255);
  const claimHash = input.claimHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(claimHash)) return { accepted: false };

  const nodes = await db.node.findMany({ where: { hostname }, select: { id: true, orgId: true }, take: 2 });
  if (nodes.length !== 1) {
    // Unknown or ambiguous hostname: pretend-accept, persist nothing.
    return { accepted: true, fingerprint: claimFingerprint(claimHash), expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString() };
  }
  const node = nodes[0]!;

  // One live claim per hostname: drop earlier pending ones (a rebooting agent
  // regenerates its secret each daemon start).
  await db.recoveryClaim.deleteMany({ where: { orgId: node.orgId, hostname, status: 'pending' } });

  const claim = await db.recoveryClaim.create({
    data: {
      orgId: node.orgId,
      nodeId: node.id,
      hostname,
      claimHash,
      fingerprint: claimFingerprint(claimHash),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
    },
    select: { id: true, fingerprint: true, expiresAt: true },
  });
  return {
    accepted: true,
    claimId: claim.id,
    fingerprint: claim.fingerprint,
    expiresAt: claim.expiresAt.toISOString(),
  };
}

export type PollClaimResult =
  | { status: 'pending' | 'denied' | 'expired' | 'unknown' }
  | { status: 'approved'; nodeId: string; sessionSecret: string; sessionVersion: number };

/** Poll a claim with the secret; an approved claim delivers its credential exactly once. */
export async function pollRecoveryClaim(
  db: DB,
  input: { claimId: string; claimSecret: string },
): Promise<PollClaimResult> {
  const claim = await db.recoveryClaim.findUnique({ where: { id: input.claimId } });
  if (!claim || claim.claimHash !== hashToken(input.claimSecret)) return { status: 'unknown' };
  if (claim.status === 'pending' && claim.expiresAt.getTime() < Date.now()) {
    await db.recoveryClaim.update({ where: { id: claim.id }, data: { status: 'expired' } });
    return { status: 'expired' };
  }
  if (claim.status === 'pending') return { status: 'pending' };
  if (claim.status === 'denied' || claim.status === 'expired') return { status: claim.status };
  if (claim.status === 'approved' && claim.credentialEnc) {
    // Decrypt BEFORE wiping (the update below clears credentialEnc; reading it
    // afterward would race that in any store that returns a live row).
    const credential = JSON.parse(decryptSecret(claim.credentialEnc)) as {
      nodeId: string;
      sessionSecret: string;
      sessionVersion: number;
    };
    // One-shot: wipe now. A second poll (or a thief who has the claim id but
    // not the wiped row) gets nothing.
    await db.recoveryClaim.update({
      where: { id: claim.id },
      data: { status: 'delivered', credentialEnc: null, resolvedAt: new Date() },
    });
    return { status: 'approved', ...credential };
  }
  return { status: 'unknown' };
}

// ── operator-facing (tRPC, org-scoped) ──────────────────────────────────────

export interface RecoveryClaimView {
  id: string;
  hostname: string;
  nodeId: string | null;
  fingerprint: string;
  createdAt: Date;
  expiresAt: Date;
}

export async function listRecoveryClaims(ctx: OrgContext): Promise<RecoveryClaimView[]> {
  const claims = await ctx.db.recoveryClaim.findMany({
    where: { orgId: ctx.activeOrgId, status: 'pending', expiresAt: { gt: new Date() } },
    select: { id: true, hostname: true, nodeId: true, fingerprint: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return claims;
}

/**
 * Approve or deny. Approval mints a fresh session credential on the node row
 * (hash stored, version bumped — the exact register-ack flow) and stages the
 * plaintext, encrypted at rest, for one delivery to the claim-secret holder.
 */
export async function resolveRecoveryClaim(
  ctx: OrgContext,
  input: { id: string; approve: boolean },
): Promise<{ status: string }> {
  const claim = await ctx.db.recoveryClaim.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId, status: 'pending' },
  });
  if (!claim) throw notFound('pending recovery claim', input.id);

  if (!input.approve) {
    await ctx.db.recoveryClaim.update({
      where: { id: claim.id },
      data: { status: 'denied', resolvedAt: new Date() },
    });
    return { status: 'denied' };
  }

  const node = claim.nodeId
    ? await ctx.db.node.findFirst({ where: { id: claim.nodeId, orgId: ctx.activeOrgId }, select: { id: true } })
    : null;
  if (!node) throw notFound('node referenced by this claim');

  const sessionSecret = `${SESSION_TOKEN_PREFIX}_${randomBytes(32).toString('base64url')}`;
  const updated = await ctx.db.node.update({
    where: { id: node.id },
    data: { sessionSecretHash: hashToken(sessionSecret), sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });
  await ctx.db.recoveryClaim.update({
    where: { id: claim.id },
    data: {
      status: 'approved',
      resolvedAt: new Date(),
      credentialEnc: encryptSecret(
        JSON.stringify({ nodeId: node.id, sessionSecret, sessionVersion: updated.sessionVersion }),
      ),
    },
  });
  return { status: 'approved' };
}
