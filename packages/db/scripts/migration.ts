/**
 * Migrations for control.db and telemetry.db, generated, never hand-written.
 *
 *   bun scripts/migration.ts <name>              next control.db migration from the schema diff
 *   bun scripts/migration.ts --telemetry <name>  the same for telemetry.db
 *   bun scripts/migration.ts --check             CI gate: every migration applies through
 *                                                ensureSchema (the boot path) and the result
 *                                                matches the schema; exits 1 on drift
 *
 * How: apply the existing migrations to a scratch SQLite file with the same
 * ensureSchema() the controller boots with, then `prisma migrate diff` from
 * that file to the schema.
 *
 * Json defaults: Prisma's SQLite DDL renders `Json @default("{}")` unquoted
 * (`DEFAULT {}`, invalid SQL), so `prisma db push` can't be used and the
 * generated SQL is fixed here by {@link quoteJsonDefaults}. The quoted form
 * introspects back equal to the schema, so the diff stays clean. (Rejected:
 * `dbgenerated("'{}'")`, which renders fine but shows as drift on every diff,
 * and dropping the defaults, which moves ~40 defaults into every create call.)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite, PrismaBunSqlite } from '../src/bun-sqlite-adapter';
import { CONTROL_MIGRATIONS_DIR, ensureSchema, TELEMETRY_MIGRATIONS_DIR } from '../src/ensure-schema';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Target {
  label: string;
  config: string;
  schema: string;
  migrations: string;
  urlEnv: string;
}

const TARGETS: Record<'control' | 'telemetry', Target> = {
  control: {
    label: 'control.db',
    config: 'prisma.config.ts',
    schema: 'prisma/schema',
    migrations: CONTROL_MIGRATIONS_DIR,
    urlEnv: 'SWARMY_DB_URL',
  },
  telemetry: {
    label: 'telemetry.db',
    config: 'prisma.telemetry.config.ts',
    schema: 'prisma/telemetry/schema.prisma',
    migrations: TELEMETRY_MIGRATIONS_DIR,
    urlEnv: 'SWARMY_TELEMETRY_DB_URL',
  },
};

/** Quote the JSON literal defaults Prisma leaves bare: `DEFAULT {}` → `DEFAULT '{}'`. */
export function quoteJsonDefaults(sql: string): string {
  return sql.replace(
    /(JSONB(?: NOT NULL)? DEFAULT )(\{.*?\}|\[.*?\])(?=,?\n|\s*\)?\s*;?\s*$)/gm,
    (_m, head: string, lit: string) => `${head}'${lit.replace(/'/g, "''")}'`,
  );
}

/** SQL that takes the applied migrations to the schema ('' when in sync). */
async function pendingDiff(t: Target): Promise<{ sql: string; applied: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-migration-'));
  const file = join(dir, 'scratch.db');
  try {
    const applied = await ensureSchema(new PrismaBunSqlite({ url: file }), t.migrations);
    // Our bookkeeping table is not in the schema; keep it out of the diff.
    const db = openSqlite(file, {});
    db.exec('DROP TABLE "_swarmy_migrations"');
    db.close();
    const res = spawnSync(
      'bunx',
      ['prisma', 'migrate', 'diff', '--config', t.config, '--from-config-datasource', '--to-schema', t.schema, '--script'],
      { cwd: pkg, env: { ...process.env, [t.urlEnv]: `file:${file}` }, encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(`prisma migrate diff failed (${t.label}):\n${res.stderr || res.stdout}`);
    const sql = quoteJsonDefaults(res.stdout)
      .split('\n')
      .filter((l) => !/^-- This is an empty migration\.?$/.test(l.trim()))
      .join('\n')
      .trim();
    return { sql, applied };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function nextName(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const nums = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => Number.parseInt(e.name.slice(0, 4), 10))
    .filter((n) => Number.isFinite(n));
  const next = String((nums.length ? Math.max(...nums) : -1) + 1).padStart(4, '0');
  return `${next}_${name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase()}`;
}

const args = process.argv.slice(2);
if (!import.meta.main) {
  // imported (tests): expose helpers only
} else {

if (args.includes('--check')) {
  let drift = false;
  for (const t of Object.values(TARGETS)) {
    const { sql, applied } = await pendingDiff(t);
    if (applied.length === 0) {
      console.error(`${t.label}: no migrations applied to a fresh file`);
      drift = true;
    }
    if (sql) {
      console.error(`${t.label}: the schema has changes with no migration:\n${sql}\n`);
      drift = true;
    } else {
      console.log(`${t.label}: ${applied.length} migration(s) apply through ensureSchema and match the schema`);
    }
  }
  if (drift) {
    console.error('Generate one with: bun run --cwd packages/db db:migration <name>  (add --telemetry for telemetry.db)');
    process.exit(1);
  }
} else {
  const telemetry = args.includes('--telemetry');
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('usage: bun scripts/migration.ts [--telemetry] <name> | --check');
    process.exit(2);
  }
  const t = TARGETS[telemetry ? 'telemetry' : 'control'];
  const { sql } = await pendingDiff(t);
  if (!sql) {
    console.log(`${t.label}: schema and migrations already match; nothing to write`);
  } else {
    const dir = join(t.migrations, nextName(t.migrations, name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'migration.sql'), `${sql}\n`);
    console.log(`${t.label}: wrote ${dir}/migration.sql`);
  }
}
}
