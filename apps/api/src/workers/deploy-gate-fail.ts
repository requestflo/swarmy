/**
 * A release that failed its safety gate (deploy-safety worker): its health
 * check judged it degraded/down, or the error trip saw its 5xx share rise.
 * Both go the same way: an alert and an incident step, then either the
 * release is marked failed or — when the app asks for it, a healthy release
 * exists and this one isn't itself an automatic put-back — the last healthy
 * release goes back out as a NEW release (gated again; the loop guard stops
 * cascades). Its start (before dispatch) and healthy instant go on the new
 * release (`markRollback`).
 */
import { prisma } from '@swarmy/db';
import { deployFromCompose, fireEvent, markRollback, recordIncidentEvent, writeAudit } from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import { failureNotes, isAutoRollbackRelease, type GateFailure } from './deploy-gate.core';

interface FailingRelease {
  id: string;
  stackName: string;
  notes: string | null;
}

export async function failRelease(ctx: OrgContext, release: FailingRelease, autoRollback: boolean, f: GateFailure): Promise<void> {
  const stack = release.stackName;
  const health = f.by === 'health';
  await fireEvent(ctx, {
    signal: 'deploy-failed',
    severity: 'critical',
    resource: `stack:${stack}`,
    message: health ? `Health gate failed for ${stack}: ${f.reasons}` : `Errors rose after ${stack}'s deploy: ${f.reasons}`,
  });
  await recordIncidentEvent(ctx, {
    groupKey: `release:${stack}`,
    kind: health ? 'deploy.gate.failed' : 'deploy.gate.errors',
    message: health ? `Release ${release.id} failed its health gate (${f.reasons})` : `Release ${release.id}: ${f.reasons}`,
    severity: 'critical',
    meta: { releaseId: release.id, stackName: stack, by: f.by },
  });

  const previousHealthy = autoRollback
    ? await prisma.release.findFirst({
        where: { orgId: ctx.activeOrgId, stackName: stack, status: 'HEALTHY' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, composeSource: true },
      })
    : null;

  if (!autoRollback || !previousHealthy || isAutoRollbackRelease(release.notes)) {
    await prisma.release.update({ where: { id: release.id }, data: { status: 'FAILED', notes: failureNotes(f, false) } });
    await writeAudit(ctx, {
      action: 'release.gate.failed',
      actorType: 'system',
      targetType: 'release',
      targetId: release.id,
      metadata: { stackName: stack, reasons: f.reasons, by: f.by, autoRollback: false },
    });
    return;
  }

  const startedAt = new Date();
  await prisma.release.update({ where: { id: release.id }, data: { status: 'ROLLED_BACK', notes: failureNotes(f, true) } });
  const deployed = await deployFromCompose(ctx, {
    name: stack,
    composeSource: previousHealthy.composeSource,
    override: true, // system remediation is never wedged by warn-level policy
  });
  if (deployed.releaseId) {
    await markRollback(ctx, {
      releaseId: deployed.releaseId,
      rollbackOf: previousHealthy.id,
      startedAt,
      notes: `Automatic rollback to release ${previousHealthy.id} (failed gate on ${release.id})`,
    });
  }
  await writeAudit(ctx, {
    action: 'release.gate.autoRollback',
    actorType: 'system',
    targetType: 'release',
    targetId: release.id,
    metadata: { stackName: stack, reasons: f.reasons, by: f.by, rolledBackTo: previousHealthy.id, newReleaseId: deployed.releaseId },
  });
  await fireEvent(ctx, {
    signal: 'deploy-rolled-back',
    severity: 'critical',
    resource: `stack:${stack}`,
    message: health
      ? `${stack} failed its health gate (${f.reasons}) and was rolled back to release ${previousHealthy.id}`
      : `${stack} was put back to release ${previousHealthy.id}: ${f.reasons}`,
  }).catch(() => undefined);
  await recordIncidentEvent(ctx, {
    groupKey: `release:${stack}`,
    kind: 'deploy.gate.rollback',
    message: `Auto-rolled ${stack} back to release ${previousHealthy.id}`,
    severity: 'warning',
    meta: { failedReleaseId: release.id, rolledBackTo: previousHealthy.id, by: f.by },
  });
}
