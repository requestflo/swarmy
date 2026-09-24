/**
 * Control-plane snapshot: a consistent copy of control.db taken with SQLite's
 * `VACUUM INTO` while the controller keeps running (a read transaction, so
 * writers are not blocked). The copy is a complete, compacted database file:
 * schema + data, no WAL. telemetry.db (MetricSample) is a separate file and is
 * never included: it is rebuildable and the largest.
 *
 * Two ways back:
 *   - disaster restore (controller stopped, `bun run restore`): the file is put
 *     in place as control.db ({@link installSnapshotFile}); boot's
 *     ensureSchema() then applies any migrations newer than the bundle.
 *   - in-place restore (running controller, tRPC): {@link loadControlPlane}
 *     ATTACHes the snapshot and replaces every table's rows in one transaction.
 */
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DB } from '@swarmy/db';

/** Tables never copied by an in-place restore (bookkeeping). */
export const EXCLUDED_TABLES = new Set(['_swarmy_migrations', '_prisma_migrations']);

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export function isSqliteFile(bytes: Uint8Array): boolean {
  return bytes.length >= SQLITE_MAGIC.length && Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length)).equals(SQLITE_MAGIC);
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Hot snapshot of control.db as file bytes. */
export async function snapshotControlPlane(db: DB): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'swarmy-snapshot-'));
  const file = join(dir, 'control.db');
  try {
    await db.$executeRaw`VACUUM INTO ${file}`;
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Disaster restore: write the snapshot as the control.db at `path`. Run with
 * the controller stopped. An existing file (and its -wal/-shm) is kept beside
 * it as `<path>.pre-restore-<ts>` rather than deleted; Litestream's sidecar
 * state for the old file is removed.
 */
export async function installSnapshotFile(bytes: Uint8Array, path: string): Promise<{ keptAs?: string }> {
  if (!isSqliteFile(bytes)) throw new Error('bundle snapshot is not a SQLite database');
  mkdirSync(dirname(path), { recursive: true });
  let keptAs: string | undefined;
  if (existsSync(path)) {
    keptAs = `${path}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(path, keptAs);
  }
  for (const side of ['-wal', '-shm']) {
    if (existsSync(path + side)) {
      if (keptAs) await rename(path + side, keptAs + side);
      else await rm(path + side, { force: true });
    }
  }
  // Litestream's replica state belongs to the file being replaced; a stale one
  // would make it resume the old lineage. It sits beside the db as .<name>-litestream.
  await rm(join(dirname(path), `.${basename(path)}-litestream`), { recursive: true, force: true });
  const tmp = `${path}.restore-tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
  return { keptAs };
}

interface NameRow {
  name: string;
}

/**
 * In-place restore into the live control.db: every table present in both the
 * snapshot and the live schema is emptied and refilled from the snapshot, in
 * one transaction, with foreign keys checked before COMMIT. Columns are
 * matched by name, so a snapshot from an older schema loads into a newer one
 * (new columns keep their defaults). Returns the tables loaded.
 */
export async function loadControlPlane(db: DB, bytes: Uint8Array): Promise<string[]> {
  if (!isSqliteFile(bytes)) throw new Error('bundle snapshot is not a SQLite database');
  const dir = await mkdtemp(join(tmpdir(), 'swarmy-restore-'));
  const file = join(dir, 'snapshot.db');
  await writeFile(file, bytes);
  // ATTACH can't run inside a transaction; it's per-connection, and the
  // controller has one.
  await db.$executeRaw`ATTACH DATABASE ${file} AS snap`;
  try {
    const listTables = async (schema: 'main' | 'snap'): Promise<string[]> =>
      (
        await db.$queryRawUnsafe<NameRow[]>(
          `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
      ).map((r) => r.name);
    const live = new Set(await listTables('main'));
    const tables = (await listTables('snap')).filter((t) => live.has(t) && !EXCLUDED_TABLES.has(t));

    const columns = new Map<string, string[]>();
    for (const t of tables) {
      const cols = await db.$queryRaw<NameRow[]>`SELECT name FROM pragma_table_info(${t}, 'main')`;
      const snapCols = new Set(
        (await db.$queryRaw<NameRow[]>`SELECT name FROM pragma_table_info(${t}, 'snap')`).map((r) => r.name),
      );
      columns.set(
        t,
        cols.map((c) => c.name).filter((c) => snapCols.has(c)),
      );
    }

    // FK enforcement is off for the copy (RESTRICT fires immediately even when
    // deferred, so row order would matter) and the result is checked before
    // COMMIT instead. foreign_keys can only change outside a transaction.
    await db.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    try {
      await db.$transaction(
        async (tx) => {
          for (const t of tables) await tx.$executeRawUnsafe(`DELETE FROM main.${quoteIdent(t)}`);
          for (const t of tables) {
            const cols = (columns.get(t) ?? []).map(quoteIdent).join(', ');
            if (!cols) continue;
            await tx.$executeRawUnsafe(
              `INSERT INTO main.${quoteIdent(t)} (${cols}) SELECT ${cols} FROM snap.${quoteIdent(t)}`,
            );
          }
          const broken = await tx.$queryRawUnsafe<unknown[]>('PRAGMA main.foreign_key_check');
          if (broken.length > 0) {
            throw new Error(`snapshot violates ${broken.length} foreign key(s); nothing was restored`);
          }
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    } finally {
      await db.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    }
    return tables;
  } finally {
    await db.$executeRaw`DETACH DATABASE snap`.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
