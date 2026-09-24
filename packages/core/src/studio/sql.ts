/**
 * SQL text the studio builds for Postgres and MySQL/MariaDB: schema
 * introspection, the paginated browse query, row edits, slow-query insights.
 *
 * Everything is LITERAL text (quoted identifiers + escaped literals, no bind
 * parameters) on purpose: the dashboard shows the exact statement before a
 * write applies, and what it shows is what runs and what is audited.
 */
import type { SqlDialect } from './sql-lex';

export type StudioValue = string | number | boolean | null;

export function quoteIdent(dialect: SqlDialect, name: string): string {
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  return '"' + name.replace(/"/g, '""') + '"';
}

/** `schema.table` (Postgres) / `table` (MySQL: the database is the session's). */
export function qualified(dialect: SqlDialect, table: { schema?: string | null; name: string }): string {
  if (dialect === 'postgres' && table.schema) return `${quoteIdent(dialect, table.schema)}.${quoteIdent(dialect, table.name)}`;
  return quoteIdent(dialect, table.name);
}

/**
 * A literal. Strings are quoted even when numeric so the server casts them to
 * the column type (`'42'` into an int, `'t'` into a boolean) — the grid edits
 * text. Postgres assumes `standard_conforming_strings=on` (the default since
 * 9.1); MySQL assumes the default (backslash escapes on).
 */
export function literal(dialect: SqlDialect, v: StudioValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (dialect === 'mysql') {
    return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'";
  }
  if (v.includes('\0')) throw new Error('Postgres text cannot contain NUL bytes');
  return "'" + v.replace(/'/g, "''") + "'";
}

export interface StudioTableRef {
  schema?: string | null;
  name: string;
}

// ── schema introspection (one query → one JSON cell) ─────────────────────────

/** Postgres: databases, tables (+ estimates, sizes), columns, indexes, as one JSON document. */
export const PG_SCHEMA_SQL = `SELECT json_build_object(
  'version', current_setting('server_version'),
  'database', current_database(),
  'databases', (SELECT coalesce(json_agg(datname ORDER BY datname), '[]'::json) FROM pg_database WHERE NOT datistemplate AND datallowconn),
  'tables', (SELECT coalesce(json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'type', c.relkind::text, 'rows', greatest(c.reltuples, 0)::bigint, 'bytes', pg_total_relation_size(c.oid)) ORDER BY n.nspname, c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'),
  'columns', (SELECT coalesce(json_agg(json_build_object('schema', table_schema, 'table', table_name, 'name', column_name, 'type', CASE WHEN data_type = 'USER-DEFINED' OR data_type = 'ARRAY' THEN udt_name ELSE data_type END, 'nullable', is_nullable = 'YES', 'default', column_default) ORDER BY table_schema, table_name, ordinal_position), '[]'::json)
    FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')),
  'indexes', (SELECT coalesce(json_agg(json_build_object('schema', n.nspname, 'table', t.relname, 'name', i.relname, 'primary', ix.indisprimary, 'unique', ix.indisunique, 'definition', pg_get_indexdef(ix.indexrelid),
      'columns', (SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]'::json) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum))), '[]'::json)
    FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%')
)::text AS schema`;

/** MySQL/MariaDB: the same document for the session's database (`DATABASE()`). */
export const MYSQL_SCHEMA_SQL = `SELECT JSON_OBJECT(
  'version', VERSION(),
  'database', DATABASE(),
  'databases', (SELECT JSON_ARRAYAGG(SCHEMA_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')),
  'tables', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', TABLE_SCHEMA, 'name', TABLE_NAME, 'type', TABLE_TYPE, 'rows', TABLE_ROWS, 'bytes', COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0))) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()),
  'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', TABLE_SCHEMA, 'table', TABLE_NAME, 'name', COLUMN_NAME, 'type', COLUMN_TYPE, 'nullable', IS_NULLABLE = 'YES', 'default', COLUMN_DEFAULT, 'pos', ORDINAL_POSITION, 'extra', EXTRA)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()),
  'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('schema', TABLE_SCHEMA, 'table', TABLE_NAME, 'name', INDEX_NAME, 'primary', INDEX_NAME = 'PRIMARY', 'unique', NON_UNIQUE = 0, 'column', COLUMN_NAME, 'seq', SEQ_IN_INDEX)) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE())
) AS \`schema\``;

export function schemaSql(dialect: SqlDialect): string {
  return dialect === 'mysql' ? MYSQL_SCHEMA_SQL : PG_SCHEMA_SQL;
}

export interface StudioColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  /** Part of the primary key (or the first unique index when there is no PK). */
  key: boolean;
}

export interface StudioIndex {
  name: string;
  columns: string[];
  primary: boolean;
  unique: boolean;
  definition?: string;
}

export interface StudioTable {
  schema: string | null;
  name: string;
  /** table | view | materialized view | foreign table | collection | … */
  type: string;
  rowsEstimate: number | null;
  bytes: number | null;
  columns: StudioColumn[];
  indexes: StudioIndex[];
  /** Columns that identify a row for edits (PK, else a unique index); empty ⇒ read-only grid. */
  keyColumns: string[];
}

export interface StudioSchema {
  version: string | null;
  database: string | null;
  databases: string[];
  tables: StudioTable[];
}

const PG_KIND: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };

interface RawSchema {
  version?: string;
  database?: string;
  databases?: string[] | null;
  tables?: Array<{ schema: string; name: string; type: string; rows: number | null; bytes: number | null }> | null;
  columns?: Array<{ schema: string; table: string; name: string; type: string; nullable: boolean | number; default: string | null; pos?: number }> | null;
  indexes?: Array<{ schema: string; table: string; name: string; primary: boolean | number; unique: boolean | number; definition?: string; columns?: string[]; column?: string; seq?: number }> | null;
}

/** Parse the one-cell JSON document {@link schemaSql} returns. */
export function parseSchemaJson(dialect: SqlDialect, text: string): StudioSchema {
  const raw = JSON.parse(text) as RawSchema;
  const key = (s: string, t: string) => `${s}\u0000${t}`;
  const cols = new Map<string, StudioColumn[]>();
  const colRows = [...(raw.columns ?? [])];
  if (dialect === 'mysql') colRows.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  for (const c of colRows) {
    const list = cols.get(key(c.schema, c.table)) ?? [];
    list.push({ name: c.name, type: c.type, nullable: Boolean(c.nullable), default: c.default ?? null, key: false });
    cols.set(key(c.schema, c.table), list);
  }
  const idx = new Map<string, StudioIndex[]>();
  if (dialect === 'mysql') {
    // STATISTICS is one row per (index, column).
    const byIndex = new Map<string, { schema: string; table: string; ix: StudioIndex; seq: Array<[number, string]> }>();
    for (const r of raw.indexes ?? []) {
      const k = `${key(r.schema, r.table)}\u0000${r.name}`;
      const e = byIndex.get(k) ?? { schema: r.schema, table: r.table, ix: { name: r.name, columns: [], primary: Boolean(r.primary), unique: Boolean(r.unique) }, seq: [] };
      e.seq.push([r.seq ?? 0, r.column ?? '']);
      byIndex.set(k, e);
    }
    for (const e of byIndex.values()) {
      e.ix.columns = e.seq.sort((a, b) => a[0] - b[0]).map((s) => s[1]);
      const list = idx.get(key(e.schema, e.table)) ?? [];
      list.push(e.ix);
      idx.set(key(e.schema, e.table), list);
    }
  } else {
    for (const r of raw.indexes ?? []) {
      const list = idx.get(key(r.schema, r.table)) ?? [];
      list.push({ name: r.name, columns: r.columns ?? [], primary: Boolean(r.primary), unique: Boolean(r.unique), ...(r.definition ? { definition: r.definition } : {}) });
      idx.set(key(r.schema, r.table), list);
    }
  }
  const tables: StudioTable[] = (raw.tables ?? [])
    .map((t) => {
      const k = key(t.schema, t.name);
      const indexes = (idx.get(k) ?? []).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
      const pk = indexes.find((i) => i.primary) ?? indexes.find((i) => i.unique);
      const keyColumns = pk?.columns ?? [];
      const columns = (cols.get(k) ?? []).map((c) => ({ ...c, key: keyColumns.includes(c.name) }));
      const type = dialect === 'postgres' ? (PG_KIND[t.type] ?? t.type) : /view/i.test(t.type) ? 'view' : 'table';
      return {
        schema: dialect === 'postgres' ? t.schema : null,
        name: t.name,
        type,
        rowsEstimate: t.rows == null ? null : Number(t.rows),
        bytes: t.bytes == null ? null : Number(t.bytes),
        columns,
        indexes,
        keyColumns: type === 'table' ? keyColumns : [],
      };
    })
    .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name));
  return {
    version: raw.version ?? null,
    database: raw.database ?? null,
    databases: [...(raw.databases ?? [])].sort(),
    tables,
  };
}

// ── browse ───────────────────────────────────────────────────────────────────

export const FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts with', 'is null', 'is not null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface BrowseFilter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface BrowseQuery {
  table: StudioTableRef;
  limit: number;
  offset: number;
  orderBy?: string | null;
  dir?: 'asc' | 'desc';
  filters?: BrowseFilter[];
}

function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (m) => '\\' + m);
}

export function filterSql(dialect: SqlDialect, f: BrowseFilter): string {
  const col = quoteIdent(dialect, f.column);
  const v = f.value ?? '';
  switch (f.op) {
    case 'is null':
      return `${col} IS NULL`;
    case 'is not null':
      return `${col} IS NOT NULL`;
    case 'contains':
    case 'starts with': {
      const pat = f.op === 'contains' ? `%${likeEscape(v)}%` : `${likeEscape(v)}%`;
      // Postgres: ILIKE over the text form, any column type. MySQL LIKE is case-insensitive by collation.
      return dialect === 'postgres' ? `${col}::text ILIKE ${literal(dialect, pat)}` : `${col} LIKE ${literal(dialect, pat)}`;
    }
    default:
      return `${col} ${f.op === '!=' ? '<>' : f.op} ${literal(dialect, v)}`;
  }
}

/** `SELECT * … LIMIT limit+1` — the extra row tells the grid there is a next page. */
export function browseSql(dialect: SqlDialect, q: BrowseQuery): string {
  const parts = [`SELECT * FROM ${qualified(dialect, q.table)}`];
  const filters = (q.filters ?? []).filter((f) => f.column);
  if (filters.length > 0) parts.push(`WHERE ${filters.map((f) => filterSql(dialect, f)).join(' AND ')}`);
  if (q.orderBy) parts.push(`ORDER BY ${quoteIdent(dialect, q.orderBy)} ${q.dir === 'desc' ? 'DESC' : 'ASC'}`);
  parts.push(`LIMIT ${Math.max(1, Math.floor(q.limit)) + 1}`);
  if (q.offset > 0) parts.push(`OFFSET ${Math.floor(q.offset)}`);
  return parts.join(' ');
}

// ── row edits ────────────────────────────────────────────────────────────────

function whereKey(dialect: SqlDialect, key: Record<string, StudioValue>): string {
  const entries = Object.entries(key);
  if (entries.length === 0) throw new Error('a row edit needs the row key (primary key or unique columns)');
  return entries
    .map(([c, v]) => (v === null ? `${quoteIdent(dialect, c)} IS NULL` : `${quoteIdent(dialect, c)} = ${literal(dialect, v)}`))
    .join(' AND ');
}

export function updateRowSql(dialect: SqlDialect, table: StudioTableRef, key: Record<string, StudioValue>, set: Record<string, StudioValue>): string {
  const sets = Object.entries(set);
  if (sets.length === 0) throw new Error('nothing to update');
  const assign = sets.map(([c, v]) => `${quoteIdent(dialect, c)} = ${literal(dialect, v)}`).join(', ');
  return `UPDATE ${qualified(dialect, table)} SET ${assign} WHERE ${whereKey(dialect, key)}${dialect === 'mysql' ? ' LIMIT 1' : ''}`;
}

export function insertRowSql(dialect: SqlDialect, table: StudioTableRef, values: Record<string, StudioValue>): string {
  const entries = Object.entries(values);
  const target = qualified(dialect, table);
  if (entries.length === 0) return dialect === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES RETURNING *`;
  const cols = entries.map(([c]) => quoteIdent(dialect, c)).join(', ');
  const vals = entries.map(([, v]) => literal(dialect, v)).join(', ');
  return `INSERT INTO ${target} (${cols}) VALUES (${vals})${dialect === 'postgres' ? ' RETURNING *' : ''}`;
}

export function deleteRowSql(dialect: SqlDialect, table: StudioTableRef, key: Record<string, StudioValue>): string {
  return `DELETE FROM ${qualified(dialect, table)} WHERE ${whereKey(dialect, key)}${dialect === 'mysql' ? ' LIMIT 1' : ''}`;
}

// ── slow-query insights ──────────────────────────────────────────────────────

/** Is pg_stat_statements installed in this database, and which timing columns does it have (PG13 renamed them)? */
export const PG_INSIGHTS_PROBE_SQL = `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements') AS ext,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'pg_stat_statements' AND column_name = 'total_exec_time') AS v13,
  current_setting('shared_preload_libraries') AS preload`;

export function pgStatStatementsSql(v13: boolean, limit = 25): string {
  const total = v13 ? 'total_exec_time' : 'total_time';
  const mean = v13 ? 'mean_exec_time' : 'mean_time';
  return `SELECT left(query, 2000) AS query, calls, round(${total}::numeric, 1) AS total_ms, round(${mean}::numeric, 2) AS mean_ms, rows FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY ${total} DESC LIMIT ${limit}`;
}

/** Always available: what is running right now, longest first. */
export const PG_ACTIVITY_SQL = `SELECT pid, usename AS "user", state, round(extract(epoch FROM now() - query_start)::numeric, 1) AS seconds, left(query, 2000) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' ORDER BY query_start LIMIT 25`;

export const MYSQL_INSIGHTS_PROBE_SQL = `SELECT @@performance_schema AS ps, @@slow_query_log AS slow, @@log_output AS output, @@long_query_time AS threshold`;

export function mysqlDigestSql(limit = 25): string {
  return `SELECT LEFT(DIGEST_TEXT, 2000) AS query, COUNT_STAR AS calls, ROUND(SUM_TIMER_WAIT / 1000000000, 1) AS total_ms, ROUND(AVG_TIMER_WAIT / 1000000000, 2) AS mean_ms, SUM_ROWS_SENT AS \`rows\` FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME = DATABASE() ORDER BY SUM_TIMER_WAIT DESC LIMIT ${limit}`;
}

export function mysqlSlowLogSql(limit = 25): string {
  return `SELECT LEFT(CONVERT(sql_text USING utf8mb4), 2000) AS query, 1 AS calls, ROUND(TIME_TO_SEC(query_time) * 1000, 1) AS total_ms, ROUND(TIME_TO_SEC(query_time) * 1000, 1) AS mean_ms, rows_sent AS \`rows\`, start_time FROM mysql.slow_log WHERE db = DATABASE() ORDER BY query_time DESC LIMIT ${limit}`;
}

export const MYSQL_ACTIVITY_SQL = `SELECT ID AS pid, USER AS \`user\`, COMMAND AS state, TIME AS seconds, LEFT(INFO, 2000) AS query FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND ID <> CONNECTION_ID() ORDER BY TIME DESC LIMIT 25`;
