import type { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';

/**
 * Shared display metadata for the DB-backup surfaces (panel, list, restore
 * dialog, Backups-page card). Engine values are the wire enum from
 * `@swarmy/core/protocol` — never redeclared here.
 */

export interface EngineMeta {
  value: DbBackupEngine;
  label: string;
  blurb: string;
}

export const DB_BACKUP_ENGINES: EngineMeta[] = [
  {
    value: 'pg_dump',
    label: 'pg_dump',
    blurb: 'Portable logical dump of one database — restore anywhere.',
  },
  {
    value: 'pg_dumpall',
    label: 'pg_dumpall',
    blurb: 'Whole-cluster logical dump including roles and globals.',
  },
  {
    value: 'snapshot-from-replica',
    label: 'Snapshot from replica',
    blurb: 'pg_dump against a read replica — zero primary load.',
  },
  {
    value: 'wal-g',
    label: 'wal-g (PITR)',
    blurb: 'Physical base backup + WAL archive — point-in-time restore.',
  },
  {
    value: 'pgbackrest',
    label: 'pgBackRest (PITR)',
    blurb: 'Physical base backup + WAL archive — point-in-time restore.',
  },
];

/** Restore modes shown by the restore confirm (db-restore-dialog). */
export const DB_RESTORE_MODES: { value: DbRestoreMode; label: string; blurb: string }[] = [
  { value: 'clone-to-new-cluster', label: 'Clone to new cluster', blurb: 'Restore into a fresh cluster — safest, nothing live is touched.' },
  { value: 'single-database', label: 'Single database', blurb: 'Restore just one database from the backup. Its current data is backed up first.' },
  { value: 'pitr', label: 'Point-in-time', blurb: 'Replay WAL up to a timestamp (wal-g / pgBackRest backups). The current data is backed up first.' },
  { value: 'in-place', label: 'In place', blurb: 'Overwrite the live primary. Its current data is backed up first.' },
];

/** The `reason` of the safety copy a restore over live data saves first (`dbBackups.restore`). */
export const PRE_RESTORE_REASON = 'pre-restore';

/** A restore point that is that safety copy: restoring it undoes the restore. */
export function isSafetyCopy(b: { reason?: string | null }): boolean {
  return b.reason === PRE_RESTORE_REASON;
}

/** How a safety copy is named wherever restore points are listed. */
export const SAFETY_COPY_WORDS = 'saved just before a restore';

export function engineLabel(engine: DbBackupEngine | null): string {
  if (!engine) return 'unknown engine';
  return DB_BACKUP_ENGINES.find((e) => e.value === engine)?.label ?? engine;
}

/** Physical engines operate on the primary's PGDATA volume. */
export function isPhysical(engine: DbBackupEngine): boolean {
  return engine === 'wal-g' || engine === 'pgbackrest';
}

export function fmtBytes(n: string | null): string {
  if (!n) return '—';
  let v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
