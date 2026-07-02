/**
 * Deploy safety worker (slice D1 owns the skeleton + health gates; slice D2
 * plugs its canary/blue-green watcher in via `deploy-canary.ts`).
 *
 * Each tick runs two hook arrays:
 *  - `healthGateChecks` (D1): watch fresh `Release` rows in `deploying`; after
 *    the gate's `windowSec` consult the stack health narrative and mark the
 *    release healthy/failed — auto-rolling back to the previous healthy release
 *    when the `swarmy.deploy.safety` label asks for it.
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
import {
  deployFromCompose,
  fireEvent,
  recordIncidentEvent,
  summarizeStack,
  systemContext,
  writeAudit,
} from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import { hub } from '../gateway';
import { canaryTick } from './deploy-canary';

const TICK_MS = 15_000;

/** Gate applied to releases deployed WITHOUT a `swarmy.deploy.safety` label so
 *  they still settle out of `deploying` (never auto-rolled-back). */
const DEFAULT_SETTLE_SEC = 120;

/** One safety watcher, run every tick. */
export type DeploySafetyHook = () => Promise<void>;

/** D1 health-gate watchers. */
export const healthGateChecks: DeploySafetyHook[] = [healthGateTick];
/** D2 canary/blue-green watchers (filled by `deploy-canary.ts`). */
export const canaryChecks: DeploySafetyHook[] = [canaryTick];

// ── pure gate decision ────────────────────────────────────────────────────────
// Mirror of @swarmy/trpc releases.service.ts `decideGate` (the unit-tested
// canonical copy — a worker cannot subpath-import an internal trpc module).

export type GateDecision = 'wait' | 'healthy' | 'failed';

export function decideGate(input: {
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  elapsedSec: number;
  windowSec: number;
}): GateDecision {
  if (input.elapsedSec < input.windowSec) return 'wait';
  if (input.health === 'healthy') return 'healthy';
  if (input.health === 'degraded' || input.health === 'down') return 'failed';
  // unknown: grace period, then benefit of the doubt — a gate never wedges.
  return input.elapsedSec < input.windowSec * 2 ? 'wait' : 'healthy';
}

/** Loop guard: an automatic rollback release never auto-rolls back again. */
export function isAutoRollbackRelease(notes: string | null): boolean {
  return (notes ?? '').startsWith('Automatic rollback');
}

// ── health-gate tick ─────────────────────────────────────────────────────────

interface GateJson {
  windowSec?: unknown;
  autoRollback?: unknown;
}

function gateOf(healthGateJson: unknown): { windowSec: number; autoRollback: boolean; configured: boolean } {
  const g = healthGateJson as GateJson | null;
  const windowSec = Number(g?.windowSec);
  if (g && Number.isFinite(windowSec) && windowSec > 0) {
    return { windowSec: Math.round(windowSec), autoRollback: g.autoRollback === true, configured: true };
  }
  return { windowSec: DEFAULT_SETTLE_SEC, autoRollback: false, configured: false };
}

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
  const elapsedSec = (Date.now() - release.createdAt.getTime()) / 1000;
  if (elapsedSec < gate.windowSec) return; // still converging — cheap early out.

  const summary = await summarizeStack(ctx, release.stackName);
  const decision = decideGate({ health: summary.status, elapsedSec, windowSec: gate.windowSec });
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
    await writeAudit(ctx, {
      action: 'release.gate.healthy',
      actorType: 'system',
      targetType: 'release',
      targetId: release.id,
      metadata: { stackName: release.stackName, windowSec: gate.windowSec },
    });
    return;
  }

  // Gate failed.
  const reasons = summary.reasons.length ? summary.reasons.join('; ') : summary.status;
  await fireEvent(ctx, {
    signal: 'deploy-health-gate',
    severity: 'critical',
    resource: `stack:${release.stackName}`,
    message: `Health gate failed for ${release.stackName}: ${reasons}`,
  });
  await recordIncidentEvent(ctx, {
    groupKey: `release:${release.stackName}`,
    kind: 'deploy.gate.failed',
    message: `Release ${release.id} failed its health gate (${reasons})`,
    severity: 'critical',
    meta: { releaseId: release.id, stackName: release.stackName },
  });

  const previousHealthy = gate.autoRollback
    ? await prisma.release.findFirst({
        where: { orgId: ctx.activeOrgId, stackName: release.stackName, status: 'HEALTHY' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, composeSource: true },
      })
    : null;

  if (!gate.autoRollback || !previousHealthy || isAutoRollbackRelease(release.notes)) {
    await prisma.release.update({
      where: { id: release.id },
      data: { status: 'FAILED', notes: `Health gate failed: ${reasons}` },
    });
    await writeAudit(ctx, {
      action: 'release.gate.failed',
      actorType: 'system',
      targetType: 'release',
      targetId: release.id,
      metadata: { stackName: release.stackName, reasons, autoRollback: false },
    });
    return;
  }

  // Auto-rollback: abandon the failed release, redeploy the previous healthy
  // compose (a NEW release, gated again — the loop guard above stops cascades).
  await prisma.release.update({
    where: { id: release.id },
    data: { status: 'ROLLED_BACK', notes: `Health gate failed: ${reasons}` },
  });
  const deployed = await deployFromCompose(ctx, {
    name: release.stackName,
    composeSource: previousHealthy.composeSource,
    override: true, // system remediation is never wedged by warn-level policy
  });
  if (deployed.releaseId) {
    await prisma.release.update({
      where: { id: deployed.releaseId },
      data: { notes: `Automatic rollback to release ${previousHealthy.id} (failed gate on ${release.id})` },
    });
  }
  await writeAudit(ctx, {
    action: 'release.gate.autoRollback',
    actorType: 'system',
    targetType: 'release',
    targetId: release.id,
    metadata: {
      stackName: release.stackName,
      reasons,
      rolledBackTo: previousHealthy.id,
      newReleaseId: deployed.releaseId,
    },
  });
  await recordIncidentEvent(ctx, {
    groupKey: `release:${release.stackName}`,
    kind: 'deploy.gate.rollback',
    message: `Auto-rolled ${release.stackName} back to release ${previousHealthy.id}`,
    severity: 'warning',
    meta: { failedReleaseId: release.id, rolledBackTo: previousHealthy.id },
  });
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
