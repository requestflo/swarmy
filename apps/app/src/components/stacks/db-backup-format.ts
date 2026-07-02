import type { DbBackupEngine } from '@swarmy/core/protocol';

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
