/**
 * `backups.copyLag` covers database schedules too: each managed Postgres
 * whose schedule copies to a second destination counts as one schedule
 * there, read off its primary's labels (`dbBackupCopy.view.ts`) rather than
 * the volume catalogue. PURE: folds the clusters into the per-destination
 * views, with the same rules (the worst lag wins and is named, a copy in
 * flight is not lag, never-copied and failing are counted apart).
 */
import type { DbBackupCopyView } from '@swarmy/core';
import type { BackupCopyLagView } from './backupCopyLag.service';

const blank = (targetId: string): BackupCopyLagView => ({
  targetId,
  schedules: 0,
  databases: 0,
  behindMs: null,
  worstVolume: null,
  neverCopied: 0,
  copying: 0,
  failing: 0,
  lastError: null,
  newestCopyAt: null,
  copiedBytes: '0',
});

export function foldDbCopies(views: readonly BackupCopyLagView[], dbs: ReadonlyArray<{ ref: string; copy: DbBackupCopyView }>): BackupCopyLagView[] {
  const out = new Map(views.map((v) => [v.targetId, { ...v }]));
  for (const { ref, copy: c } of dbs) {
    const v = out.get(c.targetId) ?? blank(c.targetId);
    out.set(c.targetId, v);
    v.schedules += 1;
    v.databases += 1;
    if (c.copying) v.copying += 1;
    if (c.neverCopied) v.neverCopied += 1;
    if (c.failing) [v.failing, v.lastError] = [v.failing + 1, v.lastError ?? c.lastError];
    if (c.newestCopyAt && (!v.newestCopyAt || c.newestCopyAt > v.newestCopyAt)) v.newestCopyAt = c.newestCopyAt;
    if (c.sizeBytes) v.copiedBytes = String(BigInt(v.copiedBytes) + BigInt(c.sizeBytes));
    if (c.behindMs != null && (v.behindMs == null || c.behindMs > v.behindMs)) [v.behindMs, v.worstVolume] = [c.behindMs, ref];
  }
  return [...out.values()];
}
