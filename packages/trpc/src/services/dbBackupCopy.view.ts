/**
 * How far a managed-Postgres schedule's "also copy to" destination trails
 * its main one (board 40: "Off-site copy · 4 min behind"). PURE: read off
 * the primary's labels (`.schedule`, `.lastRun`, `.copy`) plus whether a
 * copy is running in this controller right now.
 *
 * A logical copy is a second dump taken right after the save, so it holds
 * data at least as new as the save it follows: the lag is the newest save
 * against when the newest landed copy began (the volume schedules' rule). A
 * wal-g copy reaches a point in time (`restoresTo`): the lag is how far the
 * main destination reaches past it.
 */
import type { DbBackupCopyView, DbBackupRunStatus } from '@swarmy/core';
import type { DbBackupEngine } from '@swarmy/core/protocol';
import { copyMethod, type DbBackupCopyRecord } from './dbBackupCopy.label';

export interface DbCopyViewInput {
  schedule: { engine: DbBackupEngine; targetId?: string; secondaryTargetId?: string } | null;
  lastRun: { at: string; status: DbBackupRunStatus } | null;
  record: DbBackupCopyRecord | null;
  /** A copy of this cluster is running in this controller now. */
  copying: boolean;
  targetName: string | null;
  /** wal-g PITR: the newest moment the main destination reaches (its agent's read, else now), ms. */
  mainReachesTo: number;
}

/** The copy's view, or null when the schedule copies nowhere (or its engine can't be copied). */
export function dbCopyView(a: DbCopyViewInput): DbBackupCopyView | null {
  const dest = a.schedule?.secondaryTargetId;
  const method = a.schedule ? copyMethod(a.schedule.engine) : null;
  if (!a.schedule || !dest || dest === a.schedule.targetId || !method) return null;
  // A record about another destination (the copy moved) says nothing about this one.
  const rec = a.record?.targetId === dest ? a.record : null;
  const ok = rec?.ok ?? null;
  // Every save is followed by a copy attempt, so after a failed save the newest
  // good one is the save the last attempt copied.
  const newestSave = a.lastRun?.status === 'succeeded' ? a.lastRun.at : (rec?.savedAt ?? null);
  const failing = rec?.status === 'failed' && !a.copying;
  let behindMs: number | null = null;
  if (method === 'dump' && newestSave && ok) {
    behindMs = a.copying ? 0 : Math.max(0, Date.parse(newestSave) - Date.parse(ok.startedAt));
  } else if (method === 'walg-copy' && ok?.restoresTo) {
    behindMs = Math.max(0, a.mainReachesTo - Date.parse(ok.restoresTo));
  }
  return {
    targetId: dest,
    targetName: a.targetName,
    method,
    behindMs,
    neverCopied: newestSave != null && !ok && !a.copying,
    copying: a.copying,
    failing,
    lastError: failing ? (rec?.error ?? null) : null,
    newestCopyAt: ok?.startedAt ?? null,
    sizeBytes: ok?.sizeBytes ?? null,
    restoresTo: ok?.restoresTo ?? null,
  };
}
