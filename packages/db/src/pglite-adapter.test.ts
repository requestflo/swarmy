import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPGlite } from './pglite-adapter';
import { ensureSchema } from './ensure-schema';

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('PrismaPGlite adapter', () => {
  test('round-trips Postgres-dialect features (enum, jsonb, bigint, timestamptz)', async () => {
    const factory = new PrismaPGlite(); // in-memory
    const adapter = await factory.connect();

    // Exercises exactly the schema shapes the plan flags as SQLite-breaking:
    // native enum, jsonb, bigint autoincrement, timestamptz.
    await adapter.executeScript(`
      CREATE TYPE node_status AS ENUM ('PENDING', 'ONLINE', 'OFFLINE');
      CREATE TABLE thing (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        status node_status NOT NULL DEFAULT 'PENDING',
        labels JSONB NOT NULL DEFAULT '{}',
        ts TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const inserted = await adapter.executeRaw({
      sql: `INSERT INTO thing (status, labels) VALUES ($1, $2::jsonb)`,
      args: ['ONLINE', JSON.stringify({ region: 'eu' })],
      argTypes: [
        { scalarType: 'enum', arity: 'scalar' },
        { scalarType: 'string', arity: 'scalar' },
      ],
    });
    expect(inserted).toBe(1);

    const res = await adapter.queryRaw({
      sql: `SELECT id, status, labels, ts FROM thing`,
      args: [],
      argTypes: [],
    });
    expect(res.columnNames).toEqual(['id', 'status', 'labels', 'ts']);
    expect(res.rows.length).toBe(1);
    const [id, status, labels] = res.rows[0]!;
    // bigint comes back as a string-ish; enum/jsonb preserved.
    expect(String(id)).toBe('1');
    expect(status).toBe('ONLINE');
    const parsed = typeof labels === 'string' ? JSON.parse(labels) : labels;
    expect(parsed).toEqual({ region: 'eu' });

    await adapter.dispose();
  });

  test('transactions commit and roll back', async () => {
    const factory = new PrismaPGlite();
    const adapter = await factory.connect();
    await adapter.executeScript(`CREATE TABLE t (n INT);`);

    const tx = await adapter.startTransaction();
    await tx.executeRaw({ sql: `INSERT INTO t (n) VALUES (1)`, args: [], argTypes: [] });
    await tx.rollback();

    let res = await adapter.queryRaw({ sql: `SELECT count(*)::int FROM t`, args: [], argTypes: [] });
    expect(Number(res.rows[0]![0])).toBe(0);

    const tx2 = await adapter.startTransaction();
    await tx2.executeRaw({ sql: `INSERT INTO t (n) VALUES (2)`, args: [], argTypes: [] });
    await tx2.commit();

    res = await adapter.queryRaw({ sql: `SELECT count(*)::int FROM t`, args: [], argTypes: [] });
    expect(Number(res.rows[0]![0])).toBe(1);

    await adapter.dispose();
  });
});

describe('ensureSchema', () => {
  test('applies pending migrations once and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarmy-mig-'));
    tmpDirs.push(dir);
    await mkdir(join(dir, '0001_init'), { recursive: true });
    await writeFile(
      join(dir, '0001_init', 'migration.sql'),
      `CREATE TABLE widget (id TEXT PRIMARY KEY, name TEXT NOT NULL);`,
    );

    // Share a single in-memory instance across both ensureSchema runs.
    const { PGlite } = await import('@electric-sql/pglite');
    const client = await PGlite.create();
    const factory = new PrismaPGlite({ client });

    const first = await ensureSchema(factory, dir);
    expect(first).toEqual(['0001_init']);

    // Idempotent: second run applies nothing.
    const second = await ensureSchema(factory, dir);
    expect(second).toEqual([]);

    // The table is really there.
    const adapter = await factory.connect();
    await adapter.executeRaw({
      sql: `INSERT INTO widget (id, name) VALUES ($1, $2)`,
      args: ['w1', 'gizmo'],
      argTypes: [
        { scalarType: 'string', arity: 'scalar' },
        { scalarType: 'string', arity: 'scalar' },
      ],
    });
    const res = await adapter.queryRaw({ sql: `SELECT name FROM widget`, args: [], argTypes: [] });
    expect(res.rows[0]![0]).toBe('gizmo');
    await adapter.dispose();
  });
});
