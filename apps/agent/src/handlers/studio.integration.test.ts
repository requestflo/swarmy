/**
 * Database studio against REAL engines: postgres, mysql, mariadb, mongo, redis,
 * valkey containers on the local Docker (plain containers carrying the swarm
 * service-name label the handler looks tasks up by; data on tmpfs).
 *
 *   SWARMY_STUDIO_IT=1 bun test src/handlers/studio.integration.test.ts
 *
 * Skips unless SWARMY_STUDIO_IT=1 (it pulls/starts six database images).
 * Every container is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DockerClient } from '@swarmy/core/docker';
import { DbQueryPayload, resolveAppDbCreds, type AppDbEngine, type StudioOp } from '@swarmy/core/protocol';
import {
  MYSQL_SCHEMA_SQL,
  PG_SCHEMA_SQL,
  PG_INSIGHTS_PROBE_SQL,
  browseSql,
  deleteRowSql,
  insertRowSql,
  mongoBrowseCommand,
  parseScanReply,
  parseSchemaJson,
  redisScanArgv,
  updateRowSql,
} from '@swarmy/core/studio';
import { dbQuery } from './studio';

const RUN = process.env.SWARMY_STUDIO_IT === '1';
const docker = new DockerClient(process.env.DOCKER_SOCKET);
const tag = `studio-it-${Date.now().toString(36)}`;

interface Db {
  engine: AppDbEngine;
  image: string;
  env: string[];
  cmd?: string[];
  tmpfs: string;
  ready: StudioOp;
}

const DBS: Record<string, Db> = {
  pg: { engine: 'postgres', image: 'postgres:16', env: ['POSTGRES_PASSWORD=pg-secret'], tmpfs: '/var/lib/postgresql/data', ready: { kind: 'sql', statement: 'SELECT 1', access: 'read' } },
  mysql: { engine: 'mysql', image: 'mysql:8.4', env: ['MYSQL_ROOT_PASSWORD=my-secret', 'MYSQL_DATABASE=app'], tmpfs: '/var/lib/mysql', ready: { kind: 'sql', statement: 'SELECT 1', access: 'read' } },
  maria: { engine: 'mariadb', image: 'mariadb:11', env: ['MARIADB_ROOT_PASSWORD=ma-secret', 'MARIADB_DATABASE=app'], tmpfs: '/var/lib/mysql', ready: { kind: 'sql', statement: 'SELECT 1', access: 'read' } },
  mongo: { engine: 'mongo', image: 'mongo:7', env: ['MONGO_INITDB_ROOT_USERNAME=root', 'MONGO_INITDB_ROOT_PASSWORD=mo-secret'], tmpfs: '/data/db', ready: { kind: 'mongo', command: '{"ping":1}', access: 'read' } },
  redis: { engine: 'redis', image: 'redis:7.4', env: [], cmd: ['redis-server', '--requirepass', 're-secret'], tmpfs: '/data', ready: { kind: 'redis', argv: ['PING'], access: 'read' } },
  valkey: { engine: 'valkey', image: 'valkey/valkey:8', env: [], tmpfs: '/data', ready: { kind: 'redis', argv: ['PING'], access: 'read' } },
};

const svc = (k: string) => `${tag}-${k}`;

function payload(k: string, op: StudioOp, extra: Partial<DbQueryPayload> = {}): DbQueryPayload {
  const d = DBS[k]!;
  const creds = resolveAppDbCreds(d.engine, d.env);
  if (!creds.ok) throw new Error(creds.reason);
  return DbQueryPayload.parse({ commandId: randomUUID(), engine: d.engine, service: svc(k), creds: creds.creds, op, ...extra });
}

const q = (k: string, op: StudioOp, extra: Partial<DbQueryPayload> = {}) => dbQuery(docker, payload(k, op, extra));
const sql = (statement: string, access: 'read' | 'write' = 'read'): StudioOp => ({ kind: 'sql', statement, access });

async function waitReady(k: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      await q(k, DBS[k]!.ready);
      // mysql's entrypoint restarts the server after init — require two in a row.
      await new Promise((r) => setTimeout(r, 1500));
      await q(k, DBS[k]!.ready);
      return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`${k} never became ready: ${last}`);
}

beforeAll(async () => {
  if (!RUN) return;
  for (const [k, d] of Object.entries(DBS)) {
    await docker.pullImage(d.image).catch(() => undefined);
    const c = await docker.docker.createContainer({
      Image: d.image,
      Env: d.env,
      ...(d.cmd ? { Cmd: d.cmd } : {}),
      Labels: { 'com.docker.swarm.service.name': svc(k), 'swarmy.studio.it': tag },
      HostConfig: { Tmpfs: { [d.tmpfs]: '' }, ...(k === 'mongo' ? { Tmpfs: { '/data/db': '', '/data/configdb': '' } } : {}) },
    });
    await c.start();
  }
  await Promise.all(Object.keys(DBS).map(waitReady));
}, 300_000);

afterAll(async () => {
  if (!RUN) return;
  const list = await docker.docker.listContainers({ all: true, filters: { label: [`swarmy.studio.it=${tag}`] } });
  await Promise.all(list.map((c) => docker.docker.getContainer(c.Id).remove({ force: true, v: true }).catch(() => undefined)));
});

describe.skipIf(!RUN)('studio: postgres', () => {
  test('write, schema, browse, edits', async () => {
    await q('pg', sql('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, note text)', 'write'));
    const ins = await q('pg', sql(insertRowSql('postgres', { schema: 'public', name: 'users' }, { email: "o'reilly@example.com", note: null }), 'write'));
    expect(ins).toMatchObject({ affected: 1, columns: ['id', 'email', 'note'], rows: [['1', "o'reilly@example.com", null]] });
    await q('pg', sql("INSERT INTO users (email, note) SELECT 'u' || g || '@x', '' FROM generate_series(2, 30) g", 'write'));

    const schema = parseSchemaJson('postgres', String((await q('pg', sql(PG_SCHEMA_SQL))).rows[0]![0]));
    const users = schema.tables.find((t) => t.name === 'users')!;
    expect(users.keyColumns).toEqual(['id']);
    expect(users.columns.map((c) => [c.name, c.type])).toEqual([['id', 'integer'], ['email', 'text'], ['note', 'text']]);
    expect(schema.databases).toContain('postgres');

    const page = await q('pg', sql(browseSql('postgres', { table: { schema: 'public', name: 'users' }, limit: 10, offset: 0, orderBy: 'id', dir: 'desc' })));
    expect(page.rows).toHaveLength(11);
    expect(page.rows[0]![0]).toBe('30');
    expect(page.rows[0]![2]).toBe(''); // empty string, not NULL

    const upd = await q('pg', sql(updateRowSql('postgres', { schema: 'public', name: 'users' }, { id: '1' }, { note: 'edited, "quoted"\nnewline' }), 'write'));
    expect(upd).toMatchObject({ affected: 1, status: 'UPDATE 1' });
    const one = await q('pg', sql("SELECT note FROM users WHERE id = 1"));
    expect(one.rows).toEqual([['edited, "quoted"\nnewline']]);
    expect((await q('pg', sql(deleteRowSql('postgres', { schema: 'public', name: 'users' }, { id: '2' }), 'write'))).affected).toBe(1);
  });

  test('read-only is enforced by the server, not only the classifier', async () => {
    await q('pg', sql("CREATE FUNCTION sneaky() RETURNS int LANGUAGE sql AS $$ INSERT INTO users (email) VALUES ('sneak') RETURNING 1 $$", 'write'));
    await expect(q('pg', sql('SELECT sneaky()'))).rejects.toThrow(/read-only transaction/);
    await expect(q('pg', sql('DELETE FROM users WHERE id = 3'))).rejects.toThrow(/E_STUDIO_REFUSED/);
    await expect(q('pg', sql('SELECT 1; DELETE FROM users', 'write'))).rejects.toThrow(/one statement/);
    const count = await q('pg', sql("SELECT count(*) FROM users WHERE email = 'sneak'"));
    expect(count.rows).toEqual([['0']]);
  });

  test('limits: rows, bytes, timeout', async () => {
    const many = await q('pg', sql('SELECT g FROM generate_series(1, 5000) g'), { limits: { rowCap: 100, statementTimeoutMs: 15_000, maxBytes: 512 * 1024 } });
    expect(many).toMatchObject({ rowCount: 100, truncated: true });
    const big = await q('pg', sql("SELECT repeat('x', 1000) FROM generate_series(1, 5000)"), { limits: { rowCap: 10_000, statementTimeoutMs: 15_000, maxBytes: 64 * 1024 } });
    expect(big.truncated).toBe(true);
    expect(big.rowCount).toBeLessThan(70);
    await expect(q('pg', sql('SELECT pg_sleep(5)'), { limits: { rowCap: 10, statementTimeoutMs: 1000, maxBytes: 1024 } })).rejects.toThrow(/E_STUDIO_TIMEOUT/);
  }, 60_000);

  test('insights probe degrades without pg_stat_statements', async () => {
    const r = await q('pg', sql(PG_INSIGHTS_PROBE_SQL));
    expect(r.columns).toEqual(['ext', 'v13', 'preload']);
    expect(r.rows[0]![0]).toBeNull();
  });
});

for (const k of ['mysql', 'maria']) {
  describe.skipIf(!RUN)(`studio: ${k}`, () => {
    const dialect = 'mysql' as const;
    test('write, schema, browse, edits', async () => {
      await q(k, sql('CREATE TABLE users (id int AUTO_INCREMENT PRIMARY KEY, email varchar(200) NOT NULL, note text)', 'write'), { database: 'app' });
      const ins = await q(k, sql(insertRowSql(dialect, { name: 'users' }, { email: "o'reilly\\x@example.com", note: null }), 'write'), { database: 'app' });
      expect(ins.affected).toBe(1);
      const rows = await q(k, sql('SELECT id, email, note, \'\' AS e FROM users'), { database: 'app' });
      expect(rows).toMatchObject({ columns: ['id', 'email', 'note', 'e'], rows: [['1', "o'reilly\\x@example.com", null, '']] });
      const schema = parseSchemaJson(dialect, String((await q(k, sql(MYSQL_SCHEMA_SQL), { database: 'app' })).rows[0]![0]));
      expect(schema.tables.find((t) => t.name === 'users')?.keyColumns).toEqual(['id']);
      expect(schema.databases).toContain('app');
      const upd = await q(k, sql(updateRowSql(dialect, { name: 'users' }, { id: '1' }, { note: 'x' }), 'write'), { database: 'app' });
      expect(upd.affected).toBe(1);
      const page = await q(k, sql(browseSql(dialect, { table: { name: 'users' }, limit: 5, offset: 0, filters: [{ column: 'email', op: 'contains', value: "reilly\\" }] })), { database: 'app' });
      expect(page.rows).toHaveLength(1);
    });
    test('writes are refused read-only (classifier + agent re-check)', async () => {
      await expect(q(k, sql("UPDATE users SET note = 'x' WHERE id = 1"), { database: 'app' })).rejects.toThrow(/E_STUDIO_REFUSED/);
      await expect(q(k, sql('SELECT 1--1; DROP TABLE users', 'write'), { database: 'app' })).rejects.toThrow(/one statement/);
      await expect(q(k, sql('SELECT 1 /*! ; DROP TABLE users */', 'write'), { database: 'app' })).rejects.toThrow(/one statement/);
    });
    test('limits: rows + timeout', async () => {
      const many = await q(k, sql('WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 900) SELECT n FROM s'), { database: 'app', limits: { rowCap: 50, statementTimeoutMs: 15_000, maxBytes: 512 * 1024 } });
      expect(many).toMatchObject({ rowCount: 50, truncated: true });
      await expect(q(k, sql('SELECT SLEEP(5) FROM users'), { database: 'app', limits: { rowCap: 10, statementTimeoutMs: 1000, maxBytes: 1024 } })).rejects.toThrow(/E_STUDIO_TIMEOUT|interrupted/);
    }, 60_000);
  });
}

describe.skipIf(!RUN)('studio: mongo', () => {
  const m = (command: unknown, access: 'read' | 'write' = 'read'): StudioOp => ({ kind: 'mongo', command: JSON.stringify(command), access });
  test('insert, find, update, delete, cap', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({ n: i, name: `u${i}`, at: { $date: '2024-01-01T00:00:00Z' } }));
    expect((await q('mongo', m({ insert: 'users', documents: docs }, 'write'), { database: 'app' })).affected).toBe(40);
    const page = await q('mongo', m(mongoBrowseCommand({ collection: 'users', limit: 10, skip: 5, sort: { n: 1 } })), { database: 'app' });
    expect(page.rows).toHaveLength(11);
    expect(page.columns).toEqual(['_id', 'n', 'name', 'at']);
    expect((page.documents![0] as { n: number }).n).toBe(5);
    const capped = await q('mongo', m({ find: 'users', filter: {} }), { database: 'app', limits: { rowCap: 7, statementTimeoutMs: 15_000, maxBytes: 512 * 1024 } });
    expect(capped).toMatchObject({ rowCount: 7, truncated: true });
    const upd = await q('mongo', m({ update: 'users', updates: [{ q: { n: 1 }, u: { $set: { name: 'renamed' } } }] }, 'write'), { database: 'app' });
    expect(upd.affected).toBe(1);
    await expect(q('mongo', m({ delete: 'users', deletes: [{ q: { n: 2 }, limit: 1 }] }), { database: 'app' })).rejects.toThrow(/E_STUDIO_REFUSED/);
    const bad = q('mongo', m({ find: 'users', filter: { $bogus: 1 } }), { database: 'app' });
    await expect(bad).rejects.toThrow(/E_STUDIO_QUERY/);
  });
  test('timeout via maxTimeMS', async () => {
    await expect(
      q('mongo', m({ find: 'users', filter: { $where: 'sleep(3000) || true' } }), { database: 'app', limits: { rowCap: 10, statementTimeoutMs: 1000, maxBytes: 1024 * 64 } }),
    ).rejects.toThrow(/E_STUDIO_TIMEOUT|E_STUDIO_QUERY/);
  }, 30_000);
});

for (const k of ['redis', 'valkey']) {
  describe.skipIf(!RUN)(`studio: ${k}`, () => {
    const r = (argv: string[], access: 'read' | 'write' = 'read'): StudioOp => ({ kind: 'redis', argv, access });
    test('write, scan browser, value reads, read-only allowlist', async () => {
      expect((await q(k, r(['SET', 'user:1', 'he said "hi"\nbye'], 'write'))).status).toBe('OK');
      await q(k, r(['HSET', 'user:2', 'name', 'ann', 'city', 'café'], 'write'));
      await q(k, r(['RPUSH', 'queue', 'a', 'b', 'c'], 'write'));
      await q(k, r(['EXPIRE', 'queue', '600'], 'write'));
      const page = parseScanReply((await q(k, r(redisScanArgv('0', '*', 100)))).reply);
      expect(page.cursor).toBe('0');
      const byKey = Object.fromEntries(page.keys.map((x) => [x.key, x]));
      expect(byKey['user:1']).toMatchObject({ type: 'string', ttlMs: -1 });
      expect(byKey['user:2']).toMatchObject({ type: 'hash', size: 2 });
      expect(byKey.queue!.ttlMs).toBeGreaterThan(0);
      expect((await q(k, r(['GET', 'user:1']))).rows).toEqual([['he said "hi"\nbye']]);
      expect((await q(k, r(['HGETALL', 'user:2']))).rows).toEqual([['name', 'ann'], ['city', 'café']]);
      await expect(q(k, r(['DEL', 'user:1']))).rejects.toThrow(/E_STUDIO_REFUSED/);
      await expect(q(k, r(['EVAL', 'return 1', '0']))).rejects.toThrow(/E_STUDIO_REFUSED/);
      await expect(q(k, r(['CONFIG', 'GET', 'requirepass'], 'write'))).rejects.toThrow(/E_STUDIO_REFUSED/);
    });
    test('row cap', async () => {
      await q(k, r(['RPUSH', 'big', ...Array.from({ length: 200 }, (_, i) => String(i))], 'write'));
      const res = await q(k, r(['LRANGE', 'big', '0', '-1']), { limits: { rowCap: 25, statementTimeoutMs: 15_000, maxBytes: 512 * 1024 } });
      expect(res).toMatchObject({ rowCount: 25, truncated: true });
    });
  });
}
