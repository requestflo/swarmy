import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, PrismaBunSqlite } from './bun-sqlite-adapter';
import { ensureSchema } from './ensure-schema';

const root = mkdtempSync(join(tmpdir(), 'swarmy-ensure-schema-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function migrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'm-'));
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}

describe('ensureSchema', () => {
  it('applies the real baselines to a fresh file, then is a no-op', async () => {
    const f = new PrismaBunSqlite({ url: join(root, 'control.db') });
    const first = await ensureSchema(f);
    expect(first).toEqual(['0000_init']);
    expect(await ensureSchema(f)).toEqual([]);
  });

  it('runs each migration in a transaction: a failing one leaves nothing behind', async () => {
    const path = join(root, 'tx.db');
    const dir = migrations({
      '0000_a': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '0001_b': 'CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO nope VALUES (1);',
    });
    const f = new PrismaBunSqlite({ url: path });
    await expect(ensureSchema(f, dir)).rejects.toThrow(/0001_b failed/);
    const db = openSqlite(path, {});
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").values().flat();
    const applied = db.query('SELECT name FROM _swarmy_migrations').values().flat();
    db.close();
    expect(tables).toEqual(['_swarmy_migrations', 'a']);
    expect(applied).toEqual(['0000_a']);
  });

  it('handles comments containing ";" (whole-script exec, no naive split)', async () => {
    const dir = migrations({ '0000_c': '-- a comment; with a semicolon\nCREATE TABLE c (id TEXT); /* x; y */' });
    expect(await ensureSchema(new PrismaBunSqlite({ url: join(root, 'c.db') }), dir)).toEqual(['0000_c']);
  });
});
