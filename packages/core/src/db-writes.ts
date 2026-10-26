/**
 * Rows written since a database save (PURE): Postgres's own write counters
 * (`pg_stat_user_tables` n_tup_ins + n_tup_upd + n_tup_del, summed over the
 * database's tables) are read on the primary just before each logical save
 * and kept on that save's `db.backup` audit row; the dashboard reads them
 * again live and subtracts (`dbBackups.writes`).
 *
 * Honest about what they are: one count per inserted, updated or deleted row
 * in that one database, approximate (the statistics are flushed every few
 * seconds), and started again when the server restarts, switches over, or
 * someone runs `pg_stat_reset()`. So each reading carries the server's start
 * time and the last stats reset, and a mismatch says "can't tell" instead of
 * a number.
 */

/** One row: rows, server start (epoch s), stats reset (epoch s, 0 = never). */
export const DB_WRITES_SQL =
  'SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint AS rows, ' +
  'extract(epoch from pg_postmaster_start_time())::bigint AS server_start, ' +
  'coalesce(extract(epoch from (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database())), 0)::bigint AS stats_reset ' +
  'FROM pg_stat_user_tables';

export interface DbWriteCounters {
  /** Rows inserted + updated + deleted since the counters began. */
  rows: number;
  /** When the server started (epoch seconds): a restart or switch-over changes it. */
  serverStart: number;
  /** When this database's statistics were last reset (epoch seconds), 0 for never. */
  statsReset: number;
}

const whole = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** PURE: the counters in one result row of {@link DB_WRITES_SQL} (cells as numbers or strings), or null. */
export function parseDbWrites(cells: readonly unknown[] | undefined): DbWriteCounters | null {
  const [rows, serverStart, statsReset] = (cells ?? []).map(whole);
  if (rows == null || serverStart == null || statsReset == null) return null;
  return { rows, serverStart, statsReset };
}

/** PURE: the counters a save's audit metadata recorded (`writes`), or null for a save taken without them. */
export function dbWritesFromMeta(meta: unknown): DbWriteCounters | null {
  const w = (meta as { writes?: Partial<DbWriteCounters> } | null)?.writes;
  return w ? parseDbWrites([w.rows, w.serverStart, w.statsReset]) : null;
}

export type DbWritesSince =
  | { status: 'counted'; rows: number }
  /** The server restarted, switched over or reset its statistics since: the counters started again. */
  | { status: 'reset' };

/** PURE: rows written between a save's counters and the live ones. */
export function dbWritesSince(then: DbWriteCounters, now: DbWriteCounters): DbWritesSince {
  if (then.serverStart !== now.serverStart || then.statsReset !== now.statsReset || now.rows < then.rows) return { status: 'reset' };
  return { status: 'counted', rows: now.rows - then.rows };
}

/** `dbBackups.writes`: rows written since each save that recorded its counters. */
export interface DbWritesView {
  /** The database answered the live read. */
  read: boolean;
  database: string | null;
  /** When the live counters began (the later of the server's start and the last stats reset), ISO. */
  countingSince: string | null;
  /** Per save (the restic short id, as `dbBackups.list` shows it). */
  saves: Array<{ snapshotId: string; since: DbWritesSince }>;
}
