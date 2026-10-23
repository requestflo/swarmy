/**
 * The safety copy a managed-Postgres restore takes before it writes over live
 * data.
 *
 * A restore that lands on the cluster it came from (in-place,
 * single-database, PITR, or a clone pointed back at itself) first takes a
 * fresh LOGICAL backup of what it is about to replace. It goes through the
 * normal backup path (`backupDb`): the restore's own destination, the
 * cluster's tags plus `reason:pre-restore`, and the schedule's retention. So
 * it is in the restic catalog like any other save. It is a restore point
 * (`reason: 'pre-restore'` on the view), and undoing the restore means
 * restoring that one.
 *
 * Why logical even before a PITR: it is a copy the existing restore modes can
 * load, and it needs no PGDATA volume. The PITR path also keeps the old PGDATA
 * aside on the volume; this is the copy that lives off the box.
 *
 * If the safety copy fails, the restore is refused and nothing is touched.
 * The one way past that is an explicit `skipSafetyBackup: true`, which is
 * audited (`db.restore.safety.skip`) before the restore starts.
 */
import type { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { errorTail } from './dbPitrRestore.service';

/** The `reason:` tag value (and view `reason`) of a pre-restore safety copy. */
export const PRE_RESTORE_REASON = 'pre-restore';
/** Audit action written when a caller restores in place without a safety copy. */
export const SAFETY_SKIP_AUDIT_ACTION = 'db.restore.safety.skip';

/** The restore fields that decide whether, and how, to save first. */
export interface SafetyScope {
  stack: string;
  cluster: string;
  targetStack?: string;
  targetCluster?: string;
  mode: DbRestoreMode;
  engine: DbBackupEngine;
  database?: string;
  skipSafetyBackup?: boolean;
}

/** What to back up first: a logical engine, and the database when it is just one. */
export interface SafetyPlan {
  engine: 'pg_dump' | 'pg_dumpall';
  database?: string;
}

/** The safety copy that was taken (restore it to undo the restore). */
export interface SafetyCopy {
  snapshotId: string;
  engine: DbBackupEngine;
}

/**
 * PURE: does this restore write over the cluster it came from? Every mode
 * does when the destination is the source, a "clone" into itself included.
 * A restore into another cluster is a copy and needs no safety copy.
 */
export function overwritesSource(s: Pick<SafetyScope, 'stack' | 'cluster' | 'targetStack' | 'targetCluster'>): boolean {
  return (s.targetStack ?? s.stack) === s.stack && (s.targetCluster ?? s.cluster) === s.cluster;
}

/**
 * PURE: save what the restore replaces. A PITR or a `pg_dumpall` load
 * replaces every database, so `pg_dumpall`. Otherwise it is one database (the
 * one named, or the cluster's own), so a `pg_dump` of that one, which an
 * in-place restore can load straight back.
 */
export function safetyBackupPlan(s: Pick<SafetyScope, 'mode' | 'engine' | 'database'>): SafetyPlan {
  const wholeCluster = s.mode === 'pitr' || (s.engine === 'pg_dumpall' && s.mode !== 'single-database');
  if (wholeCluster) return { engine: 'pg_dumpall' };
  return s.database ? { engine: 'pg_dump', database: s.database } : { engine: 'pg_dump' };
}

/** `pg_dumpall` loads a SQL script; `pg_dump` and a replica dump load the same archive. */
const dumpFormat = (e: DbBackupEngine | null): string => (e === 'pg_dumpall' ? 'sql' : e === 'pg_dump' || e === 'snapshot-from-replica' ? 'archive' : 'physical');

/**
 * PURE: what a logical restore of "latest" means, decided BEFORE the safety
 * copy is taken (it would otherwise be the newest save, and the restore would
 * put back the data it was meant to replace). The newest save this engine
 * can load; null when there is none.
 */
export function latestRestorable(
  snapshots: ReadonlyArray<{ id: string; time: string; engine: DbBackupEngine | null }>,
  engine: DbBackupEngine,
): string | null {
  const want = dumpFormat(engine);
  const fit = snapshots.filter((s) => dumpFormat(s.engine) === want).sort((a, b) => b.time.localeCompare(a.time));
  return fit[0]?.id ?? null;
}

/** PURE: the plain-words refusal when the safety copy could not be taken. */
export function safetyFailedMessage(ref: string, e: unknown): string {
  return (
    `swarmy couldn't save the current data of ${ref} first, so nothing was restored: ${errorTail(e, 300)}. ` +
    'Fix that and try again, or restore without a safety copy (skipSafetyBackup: true).'
  );
}

/**
 * Take the safety copy (waiting for it to finish), or refuse the restore.
 * Returns null when nothing live is overwritten, or when the caller skipped
 * it (audited). `take` is the normal backup path, bound by the caller.
 */
export async function ensureSafetyCopy(
  ctx: OrgContext,
  scope: SafetyScope,
  take: (plan: SafetyPlan) => Promise<SafetyCopy>,
): Promise<SafetyCopy | null> {
  if (!overwritesSource(scope)) return null;
  const ref = `${scope.stack}/${scope.cluster}`;
  if (scope.skipSafetyBackup === true) {
    await writeAudit(ctx, {
      action: SAFETY_SKIP_AUDIT_ACTION,
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: ref,
      metadata: { mode: scope.mode, engine: scope.engine, database: scope.database ?? null },
    });
    return null;
  }
  try {
    const copy = await take(safetyBackupPlan(scope));
    return { snapshotId: copy.snapshotId, engine: copy.engine };
  } catch (e) {
    throw commandRejected(safetyFailedMessage(ref, e));
  }
}
