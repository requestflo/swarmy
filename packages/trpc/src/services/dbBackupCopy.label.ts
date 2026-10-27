/**
 * "Also copy to" for managed-Postgres backup schedules (board 40): the
 * `swarmy.db.backup.copy` label and the rule for which engines can copy.
 *
 * The schedule's second destination is a field of the schedule label
 * (`swarmy.db.backup.schedule` → `secondaryTargetId`), Docker truth like the
 * rest of it. After each save the controller copies it there and stamps the
 * outcome on the primary as `swarmy.db.backup.copy`, beside `.lastRun`: the
 * last attempt, plus the newest copy that landed (kept across a failure), so
 * the lag is read off labels with no agent command. PURE.
 */
import type { DbBackupEngine } from '@swarmy/core/protocol';

/** JSON outcome of the latest copy into the second destination (stamped after every copy). */
export const DB_BACKUP_COPY_LABEL = 'swarmy.db.backup.copy';

/** The newest copy that landed in the second destination. */
export interface DbBackupCopyOk {
  /** The save it copies: that save's `swarmy.db.backup.lastRun` time. */
  savedAt: string;
  /** When the copy began: it holds data at least this new. */
  startedAt: string;
  /** The copy's own id there (a restic snapshot, or the wal-g base backup copied). */
  snapshotId?: string;
  sizeBytes?: string;
  /** wal-g PITR: the newest moment a restore from the copy reaches. */
  restoresTo?: string;
}

/** Decoded `swarmy.db.backup.copy`: the last attempt, and the newest copy that landed. */
export interface DbBackupCopyRecord {
  targetId: string;
  savedAt: string;
  startedAt: string;
  status: 'succeeded' | 'failed';
  error?: string;
  ok?: DbBackupCopyOk;
}

export type CopyAttempt = { targetId: string; savedAt: string; startedAt: string } & (
  | { status: 'succeeded'; snapshotId?: string; sizeBytes?: string; restoresTo?: string }
  | { status: 'failed'; error: string }
);

/**
 * How a schedule on this engine is copied: logical saves by a second dump
 * into the second destination (the volume schedules' "also copy to" path);
 * wal-g PITR by `wal-g copy`; null = it can't be (pgBackRest writes one repo).
 */
export function copyMethod(engine: DbBackupEngine): 'dump' | 'walg-copy' | null {
  if (engine === 'pg_dump' || engine === 'pg_dumpall' || engine === 'snapshot-from-replica') return 'dump';
  return null;
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseOk(v: unknown): DbBackupCopyOk | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isTime(o.savedAt) || !isTime(o.startedAt)) return undefined;
  return {
    savedAt: o.savedAt,
    startedAt: o.startedAt,
    ...(str(o.snapshotId) ? { snapshotId: o.snapshotId } : {}),
    ...(str(o.sizeBytes) ? { sizeBytes: o.sizeBytes } : {}),
    ...(isTime(o.restoresTo) ? { restoresTo: o.restoresTo } : {}),
  };
}

/** Parse the copy label; malformed JSON degrades to null (no throw). */
export function parseCopyLabel(raw: string | undefined | null): DbBackupCopyRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!str(v.targetId) || !isTime(v.savedAt) || !isTime(v.startedAt)) return null;
    if (v.status !== 'succeeded' && v.status !== 'failed') return null;
    const ok = parseOk(v.ok);
    return {
      targetId: v.targetId,
      savedAt: v.savedAt,
      startedAt: v.startedAt,
      status: v.status,
      ...(str(v.error) ? { error: v.error } : {}),
      ...(ok ? { ok } : {}),
    };
  } catch {
    return null;
  }
}

/** The record after an attempt: a landed copy becomes `ok`; a failure keeps the last one that landed there. */
export function nextCopyRecord(prev: DbBackupCopyRecord | null, a: CopyAttempt): DbBackupCopyRecord {
  const base = { targetId: a.targetId, savedAt: a.savedAt, startedAt: a.startedAt };
  if (a.status === 'failed') {
    const carried = prev?.targetId === a.targetId ? prev.ok : undefined;
    return { ...base, status: 'failed', error: a.error, ...(carried ? { ok: carried } : {}) };
  }
  const ok: DbBackupCopyOk = {
    savedAt: a.savedAt,
    startedAt: a.startedAt,
    ...(a.snapshotId ? { snapshotId: a.snapshotId } : {}),
    ...(a.sizeBytes ? { sizeBytes: a.sizeBytes } : {}),
    ...(a.restoresTo ? { restoresTo: a.restoresTo } : {}),
  };
  return { ...base, status: 'succeeded', ok };
}
