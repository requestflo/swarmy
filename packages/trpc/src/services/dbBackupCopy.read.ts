/**
 * A cluster's "also copy to" fields, read off its primary's labels and this
 * controller's memory (a copy running now; the last read of the main WAL
 * repo for wal-g PITR). Shared by `dbBackups.overview` and `backups.copyLag`.
 */
import type { DbBackupCopyView, DbBackupRunStatus } from '@swarmy/core';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import { DB_BACKUP_COPY_LABEL, parseCopyLabel } from './dbBackupCopy.label';
import { isCopying } from './dbBackupCopy.run';
import { dbCopyView } from './dbBackupCopy.view';
import { knownPitrWindow } from './dbPitrWindow.service';

export interface CopyFieldsInput {
  orgId: string;
  /** `<stack>/<cluster>`. */
  ref: string;
  labels: Record<string, string>;
  schedule: { engine: DbBackupEngine; targetId?: string; secondaryTargetId?: string } | null;
  lastRun: { at: string; status: DbBackupRunStatus } | null;
  targetName: (id: string) => string | null;
  now: number;
}

export function copyFields(a: CopyFieldsInput): { secondaryTargetId: string | null; copy: DbBackupCopyView | null } {
  const dest = a.schedule?.secondaryTargetId ?? null;
  // wal-g archives continuously, so the main destination reaches the present,
  // or as far as its agent last read it.
  const read = knownPitrWindow(a.orgId, a.ref, a.now);
  const copy = dbCopyView({
    schedule: a.schedule,
    lastRun: a.lastRun,
    record: parseCopyLabel(a.labels[DB_BACKUP_COPY_LABEL]),
    copying: isCopying(a.orgId, a.ref),
    targetName: dest ? a.targetName(dest) : null,
    mainReachesTo: read?.window ? Date.parse(read.window.to) : a.now,
  });
  return { secondaryTargetId: dest, copy };
}
