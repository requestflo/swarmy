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
      await adapter.executeScript(sql);
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
