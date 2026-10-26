/**
 * Whole-app restore, the plan (PURE): every saved volume and managed database
 * of one app put back to one moment T.
 *
 * Each part goes to the nearest point it can reach AT OR BEFORE T: a volume
 * save, a point-in-time target inside a database's recoverable window (T
 * itself, or the window's end when T is past it), or a logical database save.
 * A part with nothing at or before T is refused, never quietly left at "now".
 * The parts rarely land on the same second, so the plan says how far apart
 * they are (`skewMs`): "files from 14:00, the database from 14:02".
 *
 * The dashboard draws this as the head moves; the controller plans again
 * from its own reads before it touches anything (`backups.restoreApp`).
 */
import type { DbBackupEngine } from './protocol/dbBackup';

/** One volume save (`backups.listSnapshots` / the `Snapshot` catalogue). */
export interface AppRestoreVolumeSave {
  id: string;
  status: string;
  startedAt: string;
}

export interface AppRestoreVolumeIn {
  volume: string;
  saves: AppRestoreVolumeSave[];
}

/** One database save (`dbBackups.list`). */
export interface AppRestoreDbSave {
  id: string;
  time: string;
  engine: DbBackupEngine | null;
}

export interface AppRestoreDbIn {
  cluster: string;
  saves: AppRestoreDbSave[];
  /** A physical PITR cluster's engine and recoverable span; null without PITR. */
  pitr: { engine: DbBackupEngine; window: { from: string; to: string } | null } | null;
}

export type AppRestoreMethod = 'volume' | 'pitr' | 'logical';

export interface AppRestorePart {
  kind: 'volume' | 'database';
  name: string;
  method: AppRestoreMethod;
  /** Volume: the catalogue's snapshot id. Logical: the restic save id. PITR: null (the base backup is picked at restore). */
  pointId: string | null;
  engine: DbBackupEngine | null;
  /** Where the part lands (ms). */
  at: number;
  /** T − at: how long before the chosen moment it lands (0 for a PITR target at T). */
  behindMs: number;
}

export interface AppRestoreRefusal {
  kind: 'volume' | 'database';
  name: string;
  /** The earliest moment this part can go back to; null when it has no save at all. */
  reachesFrom: number | null;
}

export interface AppRestorePlan {
  at: number;
  parts: AppRestorePart[];
  refused: AppRestoreRefusal[];
  /** Latest part − earliest part (ms); 0 with fewer than two parts. */
  skewMs: number;
  /** The earliest moment every part can reach; null when some part has no save. */
  reachesFrom: number | null;
  /** Something to restore and nothing refused. */
  ok: boolean;
}

/** Dumps a running server loads in place (`pg_dump`, `pg_dumpall`, a replica dump). */
export function isLogicalEngine(e: DbBackupEngine | null): boolean {
  return e === 'pg_dump' || e === 'pg_dumpall' || e === 'snapshot-from-replica';
}

const ms = (iso: string): number => Date.parse(iso);
const dated = <T>(rows: T[], time: (r: T) => string): Array<{ row: T; at: number }> =>
  rows.map((row) => ({ row, at: ms(time(row)) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);

const volumeSaves = (v: AppRestoreVolumeIn) => dated(v.saves.filter((s) => s.status === 'SUCCEEDED'), (s) => s.startedAt);
const logicalSaves = (d: AppRestoreDbIn) => dated(d.saves.filter((s) => isLogicalEngine(s.engine)), (s) => s.time);

function volumePart(v: AppRestoreVolumeIn, t: number): AppRestorePart | AppRestoreRefusal {
  const ok = volumeSaves(v);
  const best = ok.filter((x) => x.at <= t).at(-1);
  if (!best) return { kind: 'volume', name: v.volume, reachesFrom: ok[0]?.at ?? null };
  return { kind: 'volume', name: v.volume, method: 'volume', pointId: best.row.id, engine: null, at: best.at, behindMs: t - best.at };
}

/** The PITR target for T, or null when the window starts after it. */
function pitrPoint(pitr: AppRestoreDbIn['pitr'], t: number): number | null {
  if (!pitr?.window) return null;
  const from = ms(pitr.window.from);
  const to = ms(pitr.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || t < from) return null;
  return Math.min(t, to);
}

/** The earliest moment a database can go back to: its oldest logical save or the start of its window. */
function dbReachesFrom(d: AppRestoreDbIn): number | null {
  const starts = [logicalSaves(d)[0]?.at, d.pitr?.window ? ms(d.pitr.window.from) : undefined].filter((x): x is number => Number.isFinite(x));
  return starts.length ? Math.min(...starts) : null;
}

function dbPart(d: AppRestoreDbIn, t: number): AppRestorePart | AppRestoreRefusal {
  const best = logicalSaves(d).filter((x) => x.at <= t).at(-1);
  const pitrAt = pitrPoint(d.pitr, t);
  if (pitrAt !== null && d.pitr && (!best || pitrAt > best.at)) {
    return { kind: 'database', name: d.cluster, method: 'pitr', pointId: null, engine: d.pitr.engine, at: pitrAt, behindMs: t - pitrAt };
  }
  if (best) {
    return { kind: 'database', name: d.cluster, method: 'logical', pointId: best.row.id, engine: best.row.engine, at: best.at, behindMs: t - best.at };
  }
  return { kind: 'database', name: d.cluster, reachesFrom: dbReachesFrom(d) };
}

/** PURE: the whole-app plan for T. */
export function planAppRestore(input: { at: number; volumes: AppRestoreVolumeIn[]; databases: AppRestoreDbIn[] }): AppRestorePlan {
  const t = input.at;
  const all = [...input.volumes.map((v) => volumePart(v, t)), ...input.databases.map((d) => dbPart(d, t))];
  const parts = all.filter((p): p is AppRestorePart => 'method' in p);
  const refused = all.filter((p): p is AppRestoreRefusal => !('method' in p));
  const times = parts.map((p) => p.at);
  const starts = [...input.volumes.map((v) => volumeSaves(v)[0]?.at ?? null), ...input.databases.map(dbReachesFrom)];
  return {
    at: t,
    parts,
    refused,
    skewMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    reachesFrom: starts.length && starts.every((s) => s !== null) ? Math.max(...(starts as number[])) : null,
    ok: parts.length > 0 && refused.length === 0,
  };
}
