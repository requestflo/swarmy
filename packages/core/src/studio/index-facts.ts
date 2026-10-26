/**
 * The facts behind index suggestions (studio, board 63) — one bounded read
 * of the current database's statistics, returned as ONE JSON cell so it is
 * one audited `studio.query` row: per-table scan counts
 * (`pg_stat_user_tables`), per-index use and size (`pg_stat_user_indexes`),
 * and every foreign key with the column lists of the table's indexes (so
 * "is it indexed?" is decided in tested code, not SQL). Names come back as
 * `regclass` text and `quote_ident` columns: already quoted for SQL. Pure.
 */

export const INDEX_FACTS_LIMIT = { tables: 100, indexes: 100, foreignKeys: 200 } as const;

export const PG_INDEX_FACTS_SQL = [
  'SELECT json_build_object(',
  "'reset', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),",
  "'tables', (SELECT coalesce(json_agg(t), '[]'::json) FROM (",
  '  SELECT relid::regclass::text AS tbl, seq_scan, seq_tup_read, coalesce(idx_scan, 0) AS idx_scan, n_live_tup AS live, pg_relation_size(relid) AS bytes',
  `  FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT ${INDEX_FACTS_LIMIT.tables}) t),`,
  "'indexes', (SELECT coalesce(json_agg(x), '[]'::json) FROM (",
  '  SELECT s.indexrelid::regclass::text AS idx, s.relid::regclass::text AS tbl, s.idx_scan, pg_relation_size(s.indexrelid) AS bytes,',
  '    (i.indisunique OR i.indisprimary OR i.indisexclusion OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)) AS enforces',
  `  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT ${INDEX_FACTS_LIMIT.indexes}) x),`,
  "'fks', (SELECT coalesce(json_agg(f), '[]'::json) FROM (",
  '  SELECT c.conrelid::regclass::text AS tbl, c.conname AS name, c.confrelid::regclass::text AS ref, c.conkey AS keys,',
  '    ARRAY(SELECT quote_ident(a.attname) FROM unnest(c.conkey) WITH ORDINALITY AS k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,',
  '    ARRAY(SELECT i.indkey::text FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indpred IS NULL) AS idx_keys,',
  '    (SELECT u.n_live_tup FROM pg_stat_user_tables u WHERE u.relid = c.conrelid) AS live',
  "  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
  `  ORDER BY 1, 2 LIMIT ${INDEX_FACTS_LIMIT.foreignKeys}) f)`,
  ')::text AS facts',
].join('\n');

export interface TableStat { table: string; seqScan: number; seqRead: number; idxScan: number; live: number; bytes: number }
export interface IndexStat { index: string; table: string; scans: number; bytes: number; enforces: boolean }
export interface ForeignKeyStat {
  table: string;
  name: string;
  references: string;
  /** Column numbers, in key order. */
  keys: number[];
  /** Quoted column names, in key order. */
  columns: string[];
  /** Each non-partial index's column numbers, in index order (0 = an expression). */
  indexes: number[][];
  live: number;
}

export interface IndexFacts {
  /** When the database's statistics were last reset (null = never). */
  statsReset: string | null;
  tables: TableStat[];
  indexes: IndexStat[];
  foreignKeys: ForeignKeyStat[];
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(n) : []);

/** The studio's `{ columns, rows }` answer to {@link PG_INDEX_FACTS_SQL} → facts; anything malformed reads as nothing. */
export function parseIndexFacts(r: { rows: readonly (readonly unknown[])[] }): IndexFacts {
  let doc: Record<string, unknown> = {};
  try {
    const cell = r.rows[0]?.[0];
    const parsed: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell;
    if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>;
  } catch {
    doc = {};
  }
  return {
    statsReset: s(doc.reset) || null,
    tables: list(doc.tables).map((t) => ({ table: s(t.tbl), seqScan: n(t.seq_scan), seqRead: n(t.seq_tup_read), idxScan: n(t.idx_scan), live: n(t.live), bytes: n(t.bytes) })),
    indexes: list(doc.indexes).map((x) => ({ index: s(x.idx), table: s(x.tbl), scans: n(x.idx_scan), bytes: n(x.bytes), enforces: x.enforces === true })),
    foreignKeys: list(doc.fks).map((f) => ({
      table: s(f.tbl),
      name: s(f.name),
      references: s(f.ref),
      keys: nums(f.keys),
      columns: Array.isArray(f.cols) ? f.cols.map(s) : [],
      indexes: (Array.isArray(f.idx_keys) ? f.idx_keys : []).map((k) => s(k).trim().split(/\s+/).filter(Boolean).map(Number)),
      live: n(f.live),
    })),
  };
}
