/**
 * Deploy safety worker (slice D1 owns the skeleton + health gates; slice D2
 * plugs its canary/blue-green watcher in via `deploy-canary.ts`).
 *
 * Each tick runs two hook arrays:
 *  - `healthGateChecks` (D1): watch fresh `Release` rows in `deploying`; after
 *    the gate's `windowSec` consult the stack health narrative and mark the
 *    release healthy/failed — auto-rolling back to the previous healthy release
 *    when the `swarmy.deploy.safety` label asks for it. Inside the window the
 *    error trip (`deploy-error-trip.ts`, pure rule in `@swarmy/core`) fails
 *    it early when the app's 5xx share at the edge rises; the failure path is
 *    `deploy-gate-fail.ts`, the pure bits `deploy-gate.core.ts`.
 *  - `canaryChecks` (D2): promote/rollback canary + blue/green deploys. D2
 *    registers by filling `canaryTick` in `deploy-canary.ts` — this file never
 *    changes for it.
 *
 * Reuses `@swarmy/trpc` package-root seams (systemContext, summarizeStack,
 * deployFromCompose, fireEvent, recordIncidentEvent, writeAudit) — the same
 * pattern as image-gc / ingress-reconcile.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { errorTripWatchSec } from '@swarmy/core';
import { appTrafficMinutes, fireEvent, summarizeStack, systemContext, writeAudit } from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import { hub } from '../gateway';
import { canaryTick } from './deploy-canary';
import { errorTripCheck, forgetErrorTrips } from './deploy-error-trip';
import { failRelease } from './deploy-gate-fail';
import { decideGate, gateOf, isAutoRollbackRelease } from './deploy-gate.core';

const TICK_MS = 15_000;

/** One safety watcher, run every tick. */
export type DeploySafetyHook = () => Promise<void>;

/** D1 health-gate watchers. */
export const healthGateChecks: DeploySafetyHook[] = [healthGateTick];
/** D2 canary/blue-green watchers (filled by `deploy-canary.ts`). */
export const canaryChecks: DeploySafetyHook[] = [canaryTick];

// ── health-gate tick ─────────────────────────────────────────────────────────

async function judgeRelease(
  ctx: OrgContext,
  release: {
    id: string;
    stackName: string;
    notes: string | null;
    healthGateJson: unknown;
    createdAt: Date;
  },
): Promise<void> {
  const gate = gateOf(release.healthGateJson);
  // The error trip watches every whole minute of the window, before the health verdict.
  if (gate.errorTripPct !== null && !isAutoRollbackRelease(release.notes)) {
    const read = (from: number, to: number) => appTrafficMinutes(ctx, release.stackName, from, to);
    const reasons = errorTripCheck(read, release, gate.errorTripPct);
    if (reasons) return failRelease(ctx, release, gate.autoRollback, { by: 'errors', reasons });
  }
  // With the trip on the watch is long enough for the full minutes it needs.
  const windowSec = gate.errorTripPct !== null ? Math.max(gate.windowSec, errorTripWatchSec()) : gate.windowSec;
  const elapsedSec = (Date.now() - release.createdAt.getTime()) / 1000;
  if (elapsedSec < windowSec) return; // still converging — cheap early out.

  const summary = await summarizeStack(ctx, release.stackName);
  const decision = decideGate({ health: summary.status, elapsedSec, windowSec });
  if (decision === 'wait') return;

  if (decision === 'healthy') {
    // The new head is healthy: promote it and supersede the old healthy head.
    await prisma.release.updateMany({
      where: {
        orgId: ctx.activeOrgId,
        stackName: release.stackName,
        status: 'HEALTHY',
        id: { not: release.id },
      },
      data: { status: 'SUPERSEDED' },
    });
    await prisma.release.update({ where: { id: release.id }, data: { status: 'HEALTHY' } });
    // A healthy release clears any open deploy-failed alert for the stack.
    await fireEvent(ctx, {
      signal: 'deploy-failed',
      severity: 'info',
      resource: `stack:${release.stackName}`,
      message: `${release.stackName} is healthy again (release ${release.id})`,
      status: 'resolved',
    }).catch(() => undefined);
    await writeAudit(ctx, {
      action: 'release.gate.healthy',
      actorType: 'system',
      targetType: 'release',
      targetId: release.id,
      metadata: { stackName: release.stackName, windowSec },
    });
    return;
  }

  const reasons = summary.reasons.length ? summary.reasons.join('; ') : summary.status;
  await failRelease(ctx, release, gate.autoRollback, { by: 'health', reasons });
}

async function healthGateTick(): Promise<void> {
  const deploying = await prisma.release.findMany({
    where: { status: 'DEPLOYING' },
    select: {
      id: true,
      orgId: true,
      stackName: true,
      notes: true,
      healthGateJson: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  forgetErrorTrips(new Set(deploying.map((r) => r.id)));
  if (deploying.length === 0) return;

  const auth = authRegistry.getAuth();
  const byOrg = new Map<string, typeof deploying>();
  for (const r of deploying) {
    const list = byOrg.get(r.orgId) ?? [];
    list.push(r);
    byOrg.set(r.orgId, list);
  }
  for (const [orgId, releases] of byOrg) {
    const ctx = systemContext({ db: prisma, hub, auth }, orgId);
    for (const release of releases) {
      await judgeRelease(ctx, release).catch(() => undefined);
    }
  }
}

// ── tick loop ────────────────────────────────────────────────────────────────

export function startDeploySafety(): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow tick
    running = true;
    try {
      for (const hook of [...healthGateChecks, ...canaryChecks]) {
        await hook().catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
  // Defer the first run so the gateway/hub is warm and nodes have reconnected.
  const kickoff = setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
