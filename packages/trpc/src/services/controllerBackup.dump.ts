/**
 * Logical control-plane dump — mode-agnostic (works on PGlite and server
 * Postgres via the same Prisma raw interface). We dump *data* as portable
 * `INSERT` statements; schema is recreated on restore by `prisma migrate deploy`
 * / `ensureSchema()` (the design doc's restore flow), so the dump never carries
 * DDL and restores cleanly across swarmy/PG versions.
 *
 * `metric_sample` is excluded by default: it is rebuildable telemetry, not
 * control-plane truth, and is the largest table — keeping it out makes the
 * bundle small and restore fast (per the epic's open-question resolution).
 */
import type { DB } from '@swarmy/db';

/** Tables never included in a control-plane dump (rebuildable telemetry). */
export const EXCLUDED_TABLES = new Set(['metric_sample', '_swarmy_migrations', '_prisma_migrations']);

interface RawRow {
  [k: string]: unknown;
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return `'\\x${Buffer.from(v).toString('hex')}'`;
  }
  if (typeof v === 'object') {
    // jsonb / json / arrays → JSON text literal, cast applied at column level by PG.
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** List user tables in the public schema, excluding telemetry/bookkeeping. */
export async function listDumpTables(db: DB): Promise<string[]> {
  const rows = (await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )) as { tablename: string }[];
  return rows.map((r) => r.tablename).filter((t) => !EXCLUDED_TABLES.has(t));
}

export interface DumpResult {
  sql: string;
  tableCount: number;
  rowCount: number;
}

/**
 * Produce a logical INSERT-based dump of the control-plane tables. The output is
 * wrapped so it can be loaded as-is after the schema exists:
 *   - `SET session_replication_role = replica;` defers FK checks during load
 *   - per-table `DELETE` + `INSERT`s (idempotent load into a migrated schema)
 */
export async function dumpControlPlane(db: DB): Promise<DumpResult> {
  const tables = await listDumpTables(db);
  const out: string[] = [
    '-- swarmy controller-state logical dump (data only; schema via migrate deploy)',
    'SET session_replication_role = replica;',
    'BEGIN;',
  ];
  let rowCount = 0;
  for (const table of tables) {
    const rows = (await db.$queryRawUnsafe(
      `SELECT * FROM ${quoteIdent(table)}`,
    )) as RawRow[];
    out.push(`-- table: ${table} (${rows.length} rows)`);
    out.push(`DELETE FROM ${quoteIdent(table)};`);
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]!);
    const colList = cols.map(quoteIdent).join(', ');
    for (const row of rows) {
      const vals = cols.map((c) => quoteValue(row[c])).join(', ');
      out.push(`INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${vals});`);
      rowCount++;
    }
  }
  out.push('COMMIT;', "SET session_replication_role = 'origin';", '');
  return { sql: out.join('\n'), tableCount: tables.length, rowCount };
}

/**
 * Load a dump produced by {@link dumpControlPlane} into a (already-migrated) DB.
 * Executes the whole script; statements are ordered for a consistent load.
 */
export async function loadControlPlane(db: DB, sql: string): Promise<void> {
  // The Prisma client executes a multi-statement script via executeRawUnsafe
  // (the underlying adapter's executeScript handles the BEGIN/COMMIT semantics).
  await db.$executeRawUnsafe(sql);
}
