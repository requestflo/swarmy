/**
 * Copy a managed-Postgres save into the schedule's second destination, right
 * after the save succeeded (board 40's "also copy to"). The volume schedules'
 * path, reused: the same backup again into the second destination
 * (`backup-scheduler` `backupToTarget` there; a second `db.backup` here),
 * catalogued under that destination. The caller passes the copy itself, so
 * this module needs nothing from dbBackup.service.
 *
 * A failed copy never fails the save. The outcome is stamped on the primary
 * (`swarmy.db.backup.copy`), and audited: `db.backup.copy` on success (by
 * backupDb), `db.backup.copy.failed` here. Copies running now are process
 * memory: one controller runs them, and a copy in flight is not lag.
 */
import type { DbBackupEngine } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { errorTail } from './dbPitrRestore.service';
import { resolveManagerNode } from './dispatch.service';
import { DB_BACKUP_COPY_LABEL, copyMethod, nextCopyRecord, parseCopyLabel, type DbBackupCopyRecord } from './dbBackupCopy.label';

const running = new Set<string>();
const key = (orgId: string, ref: string): string => `${orgId}\u0000${ref}`;

/** Is a copy of `<stack>/<cluster>` running in this controller now? */
export function isCopying(orgId: string, ref: string): boolean {
  return running.has(key(orgId, ref));
}

export interface CopyAfterSave {
  stack: string;
  cluster: string;
  /** The primary service the labels live on, and its copy label before this save. */
  primaryService: string;
  previous: string | undefined;
  engine: DbBackupEngine;
  /** The destination the save went to, and the second one to copy it into. */
  targetId: string;
  secondaryTargetId: string | undefined;
  /** The save: its lastRun time and id. */
  saved: { at: string; snapshotId: string };
  /** Make the copy in the second destination. */
  copy: (targetId: string) => Promise<{ snapshotId?: string; sizeBytes?: string; restoresTo?: string }>;
}

/** Copy the save when the schedule names a second destination; never throws. Returns the stamped record. */
export async function copyAfterSave(ctx: OrgContext, a: CopyAfterSave): Promise<DbBackupCopyRecord | null> {
  const dest = a.secondaryTargetId;
  if (!dest || dest === a.targetId || !copyMethod(a.engine)) return null;
  const ref = `${a.stack}/${a.cluster}`;
  const k = key(ctx.activeOrgId, ref);
  if (running.has(k)) return null;
  running.add(k);
  const startedAt = new Date().toISOString();
  const base = { targetId: dest, savedAt: a.saved.at, startedAt };
  let record: DbBackupCopyRecord;
  try {
    const r = await a.copy(dest);
    record = nextCopyRecord(parseCopyLabel(a.previous), { ...base, status: 'succeeded', ...r });
  } catch (e) {
    record = nextCopyRecord(parseCopyLabel(a.previous), { ...base, status: 'failed', error: errorTail(e) });
    await writeAudit(ctx, {
      action: 'db.backup.copy.failed',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'dbCluster',
      targetId: ref,
      metadata: { engine: a.engine, targetId: dest, copyOf: a.saved.snapshotId, error: record.error ?? null },
    });
  } finally {
    running.delete(k);
  }
  await stampCopy(ctx, a.primaryService, record);
  return record;
}

/** Best-effort: a failed stamp only delays the lag figure, never the copy. */
async function stampCopy(ctx: OrgContext, service: string, record: DbBackupCopyRecord): Promise<void> {
  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service,
      add: { [DB_BACKUP_COPY_LABEL]: JSON.stringify(record) },
      removeKeys: [],
    });
  } catch {
    // the next copy stamps again
  }
}
