/**
 * Boot reconcile for work the previous controller process was driving.
 *
 * A build's completion (and the app plan waiting on it) is an in-memory await
 * in the controller that dispatched it. A controller restart (a lease fence,
 * an update, a move) dropped that await. The build then stayed `building`
 * forever, and its plan stayed `applying`, which nothing can retry. On boot,
 * anything the previous process left in flight is marked FAILED with a clear
 * reason: there is no live builder to adopt, since the builder's result went
 * to a socket that no longer exists. The plan becomes retryable
 * (apps.retryPlan / "Deploy now").
 */
import type { DB } from '@swarmy/db';
import { buildLogBus } from './build-log-bus';

export const ORPHANED_BUILD_REASON = 'the controller restarted while this build was running; deploy again to retry';
export const ORPHANED_PLAN_REASON = 'interrupted by a controller restart — Retry to run it again';

const IN_FLIGHT_BUILDS = ['QUEUED', 'BUILDING', 'PUSHING'] as const;

export interface OrphanReconcileResult {
  builds: string[];
  plans: string[];
}

/** Mark everything the previous process left in flight (created before `bootAt`) as failed. */
export async function reconcileOrphanedWork(db: DB, bootAt: Date, now: Date = new Date()): Promise<OrphanReconcileResult> {
  const builds = await db.build.findMany({
    where: { status: { in: [...IN_FLIGHT_BUILDS] as never }, createdAt: { lt: bootAt } },
    select: { id: true, orgId: true, logsRef: true },
  });
  for (const b of builds) {
    await db.build.update({ where: { id: b.id }, data: { status: 'FAILED' as never, finishedAt: now } });
    if (b.logsRef) {
      buildLogBus.push(b.logsRef, { seq: Number.MAX_SAFE_INTEGER, stream: 'stderr', ts: now.getTime(), message: `swarmy: ${ORPHANED_BUILD_REASON}` }, true);
    }
    await db.auditLog
      .create({
        data: {
          orgId: b.orgId,
          actorType: 'system',
          action: 'cicd.build.orphaned',
          targetType: 'build',
          targetId: b.id,
          metadata: { reason: ORPHANED_BUILD_REASON },
        },
      })
      .catch(() => undefined);
  }
  const plans = await db.appPlan.findMany({
    where: { status: 'applying', updatedAt: { lt: bootAt } },
    select: { id: true, orgId: true },
  });
  for (const p of plans) {
    await db.appPlan.update({ where: { id: p.id }, data: { status: 'failed', error: ORPHANED_PLAN_REASON } });
    await db.auditLog
      .create({
        data: {
          orgId: p.orgId,
          actorType: 'system',
          action: 'app.plan.orphaned',
          targetType: 'appPlan',
          targetId: p.id,
          metadata: { reason: ORPHANED_PLAN_REASON },
        },
      })
      .catch(() => undefined);
  }
  return { builds: builds.map((b) => b.id), plans: plans.map((p) => p.id) };
}
