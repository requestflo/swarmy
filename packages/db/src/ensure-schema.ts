/**
 * Boot-time schema bring-up for lite (PGlite) mode.
 *
 * A fresh single-binary install boots on an empty embedded Postgres data dir,
 * so the controller must self-migrate with no `bun db:push`. `ensureSchema()`
 * applies the project's Prisma migration SQL (in dependency order) against the
 * active adapter, tracking what's been applied in `_swarmy_migrations` so it's
 * idempotent across restarts.
 *
 * This is gated to lite mode at the call site (apps/api boot): server Postgres
 * keeps the explicit `prisma migrate deploy` operational flow.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlDriverAdapter, SqlMigrationAwareDriverAdapterFactory } from '@prisma/driver-adapter-utils';

const MIGRATIONS_TABLE = '_swarmy_migrations';

function migrationsDir(): string {
  // src/ → ../prisma/migrations
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'prisma', 'migrations');
}

async function listMigrationFiles(dir: string): Promise<{ name: string; sql: string }[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: { name: string; sql: string }[] = [];
  for (const name of entries) {
    try {
      const sql = await readFile(join(dir, name, 'migration.sql'), 'utf8');
      out.push({ name, sql });
    } catch {
      // skip dirs without a migration.sql
    }
  }
  return out;
}

/**
 * Drop SQL comments (`-- …` to end of line, and `/* … *\/` blocks) outside
 * quoted strings/identifiers. The Postgres adapter's `executeScript` splits a
 * script on `;` without understanding comments, so a `;` inside a comment
 * (e.g. "serial);" in 0003's header) cut a statement in half and every
 * standard-tier install crash-looped on boot. PGlite ran it whole, so lite
 * installs never saw it.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      // copy a quoted run verbatim; '' / "" escapes stay inside the run
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Apply all pending migrations against `adapterFactory`. Returns the list of
 * migration names freshly applied (empty if already up to date).
 *
 * @param dir override the migrations directory (used by tests).
 */
export async function ensureSchema(
  adapterFactory: SqlMigrationAwareDriverAdapterFactory,
  dir: string = migrationsDir(),
): Promise<string[]> {
  const adapter: SqlDriverAdapter = await adapterFactory.connect();
  try {
    await adapter.executeScript(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
    const appliedRes = await adapter.queryRaw({
      sql: `SELECT name FROM "${MIGRATIONS_TABLE}"`,
      args: [],
      argTypes: [],
    });
    const applied = new Set(appliedRes.rows.map((r) => String(r[0])));

    const files = await listMigrationFiles(dir);
    const freshlyApplied: string[] = [];
    for (const { name, sql } of files) {
      if (applied.has(name)) continue;
      await adapter.executeScript(stripSqlComments(sql));
      await adapter.executeRaw({
        sql: `INSERT INTO "${MIGRATIONS_TABLE}" (name) VALUES ($1)`,
        args: [name],
        argTypes: [{ scalarType: 'string', arity: 'scalar' }],
      });
      freshlyApplied.push(name);
    }
    return freshlyApplied;
  } finally {
    await adapter.dispose();
  }
}
