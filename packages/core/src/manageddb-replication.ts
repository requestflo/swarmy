/**
 * How far behind each standby copy is (board 39, PgDetail): one row of
 * `pg_stat_replication` per connected standby, read on the PRIMARY through
 * the studio's bounded, audited read (`db.replication`). PURE — the SQL, the
 * row parser and the task matcher; tested in manageddb-replication.test.ts.
 *
 * A standby names itself to the primary by `application_name`, which the boot
 * layer sets to the container hostname (`manageddb-pg.ts`): a swarm task's
 * hostname is the first 12 hex of its container id, so the row is matched
 * back to its task, service and server by that prefix. A row that matches no
 * task (a `pg_basebackup` clone in flight, a hand-set hostname) keeps its name
 * and no member.
 *
 * Seconds are `replay_lag`, which Postgres leaves NULL once a standby has
 * caught up and nothing new is written: null is "not measured", never a zero.
 * Bytes are `pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)`.
 */

/**
 * One row per standby, or a single row with NULL standby columns when none is
 * connected (so the primary's own LSN always comes back).
 */
export const PG_REPLICATION_SQL =
  'SELECT r.application_name AS name, r.client_addr::text AS addr, r.state, r.sync_state, ' +
  'r.sent_lsn::text AS sent_lsn, r.replay_lsn::text AS replay_lsn, pg_current_wal_lsn()::text AS primary_lsn, ' +
  'pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn)::bigint AS lag_bytes, ' +
  'EXTRACT(EPOCH FROM r.replay_lag)::float8 AS lag_seconds ' +
  'FROM (SELECT 1) AS one LEFT JOIN pg_stat_replication r ON true ORDER BY r.application_name';

export interface PgStandbyRow {
  /** `application_name`: the standby's container hostname. */
  name: string;
  addr: string | null;
  /** `streaming` · `catchup` · `startup` · `backup` · `stopping`. */
  state: string | null;
  /** `async` · `sync` · `potential` · `quorum`. */
  syncState: string | null;
  sentLsn: string | null;
  replayLsn: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
}

export interface PgReplicationRows {
  primaryLsn: string | null;
  standbys: PgStandbyRow[];
}

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const count = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : null;
};

/** The studio's `{ columns, rows }` answer to {@link PG_REPLICATION_SQL} → typed rows. */
export function parseReplicationRows(r: { columns: readonly string[]; rows: readonly (readonly unknown[])[] }): PgReplicationRows {
  const col = (name: string) => r.columns.indexOf(name);
  const at = (row: readonly unknown[], name: string) => (col(name) >= 0 ? row[col(name)] : undefined);
  let primaryLsn: string | null = null;
  const standbys: PgStandbyRow[] = [];
  for (const row of r.rows) {
    primaryLsn ??= text(at(row, 'primary_lsn'));
    const name = text(at(row, 'name'));
    if (name === null && text(at(row, 'replay_lsn')) === null) continue;
    const secs = count(at(row, 'lag_seconds'));
    standbys.push({
      name: name ?? 'unnamed standby',
      addr: text(at(row, 'addr')),
      state: text(at(row, 'state')),
      syncState: text(at(row, 'sync_state')),
      sentLsn: text(at(row, 'sent_lsn')),
      replayLsn: text(at(row, 'replay_lsn')),
      lagBytes: count(at(row, 'lag_bytes')),
      lagSeconds: secs === null ? null : Math.round(secs * 10) / 10,
    });
  }
  return { primaryLsn, standbys };
}

/** A running task the matcher can name a row after. */
export interface StandbyTask {
  containerId: string;
  service: string;
  nodeId: string;
}

/** The task whose container id starts with the row's hostname (≥ 12 hex, the swarm default). */
export function matchStandbyTask(name: string, tasks: readonly StandbyTask[]): StandbyTask | null {
  const host = name.trim().toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(host)) return null;
  return tasks.find((t) => t.containerId.toLowerCase().startsWith(host)) ?? null;
}
