/**
 * Data scenarios: managed Postgres backup → restore-as-copy, and logical
 * dump/restore of a compose MariaDB and Redis (backups.appDb.*).
 */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context';
import { assert, log, poll, secret } from '../lib/util';

/** A node-local restic target (a directory on the node that runs the job). */
async function backupTarget(ctx: Ctx): Promise<string> {
  const cached = ctx.kv.get('targetId');
  if (cached) return cached;
  const t = await ctx.m<{ id: string }>('backups.addTarget', {
    name: `e2e-disk-${ctx.runId}`,
    kind: 'node',
    bucket: '/srv/swarmy-e2e-backups',
    prefix: `e2e-${ctx.runId}`,
  });
  assert(t?.id, 'backups.addTarget returned no id');
  ctx.kv.set('targetId', t.id);
  return t.id;
}

const running = (ctx: Ctx, svc: string, timeoutMs = 6 * 60_000) =>
  poll(`${svc} running`, () => ctx.task(svc), { timeoutMs, intervalMs: 5000 });

// ── 6. managed Postgres ────────────────────────────────────────────────────
export async function postgres(ctx: Ctx) {
  const stack = `e2epg-${ctx.runId}`;
  const targetId = await backupTarget(ctx);
  const rows = 50;
  try {
    const src = await ctx.m<{ password: string; primaryService: string }>('db.provision', { stack, name: 'pg', replicas: 0 }, 5 * 60_000);
    const pw = secret(src.password);
    const primary = src.primaryService || `${stack}_pg-primary`;
    await running(ctx, primary);
    const psql = (svc: string, password: string, sql: string) =>
      ctx.execIn(svc, `psql -h 127.0.0.1 -U postgres -d app -v ON_ERROR_STOP=1 -tAc "${sql}"`, { env: { PGPASSWORD: password } });
    await poll('postgres accepting connections', () => psql(primary, pw, 'SELECT 1'), { timeoutMs: 3 * 60_000, intervalMs: 5000 });
    await psql(primary, pw, `CREATE TABLE e2e_rows (id int PRIMARY KEY, v text); INSERT INTO e2e_rows SELECT g, md5(g::text) FROM generate_series(1,${rows}) g`);
    const sum = (await psql(primary, pw, 'SELECT count(*) || \':\' || md5(string_agg(v, \',\' ORDER BY id)) FROM e2e_rows')).trim();
    log(`wrote ${rows} rows (${sum})`);

    const t0 = Date.now();
    const b = await ctx.m<{ snapshotId: string; sizeBytes: number; engine: string }>(
      'dbBackups.backup',
      { stack, cluster: 'pg', engine: 'pg_dump', targetId },
      10 * 60_000,
    );
    assert(b.snapshotId, 'dbBackups.backup returned no snapshotId');
    log(`backup ${b.snapshotId} (${b.engine}, ${b.sizeBytes} bytes) in ${Math.round((Date.now() - t0) / 1000)}s`);
    const listed = await ctx.q<{ id: string }[]>('dbBackups.list', { targetId, stack, cluster: 'pg' });
    assert(listed.some((s) => b.snapshotId.startsWith(s.id) || s.id.startsWith(b.snapshotId)), 'snapshot missing from dbBackups.list');

    // Restore AS A COPY: a new cluster, then clone the snapshot into it.
    const copy = await ctx.m<{ password: string; primaryService: string }>('db.provision', { stack, name: 'pgcopy', replicas: 0 }, 5 * 60_000);
    const cpw = secret(copy.password);
    const copyPrimary = copy.primaryService || `${stack}_pgcopy-primary`;
    await running(ctx, copyPrimary);
    await poll('copy accepting connections', () => psql(copyPrimary, cpw, 'SELECT 1'), { timeoutMs: 3 * 60_000, intervalMs: 5000 });
    const r = await ctx.m<{ bytesRestored: number | string }>(
      'dbBackups.restore',
      { stack, cluster: 'pg', engine: 'pg_dump', mode: 'clone-to-new-cluster', snapshotId: b.snapshotId, targetId, targetStack: stack, targetCluster: 'pgcopy' },
      10 * 60_000,
    );
    log(`restored ${r.bytesRestored} bytes into pgcopy`);
    const got = (await psql(copyPrimary, cpw, 'SELECT count(*) || \':\' || md5(string_agg(v, \',\' ORDER BY id)) FROM e2e_rows')).trim();
    assert(got === sum, `copy has ${got}, source had ${sum}`);
    // The source is untouched by a copy-restore.
    assert((await psql(primary, pw, 'SELECT count(*) FROM e2e_rows')).trim() === String(rows), 'source rows changed');
    return `${rows} rows → pg_dump ${b.sizeBytes}B → restored into a new cluster, checksums match`;
  } finally {
    if (!ctx.opts.keep) await ctx.sdk.stacks.remove(stack).catch(() => {});
  }
}

// ── 7. MariaDB + Redis logical dump/restore ────────────────────────────────
export async function mariadbRedis(ctx: Ctx) {
  const stack = `e2edb-${ctx.runId}`;
  const targetId = await backupTarget(ctx);
  const rootPw = secret(randomBytes(12).toString('hex'));
  const marker = `m-${ctx.runId}`;
  // Plain env on purpose: appDb reads MARIADB_ROOT_PASSWORD from the spec
  // (a delivery:"env" secret var would be invisible to it — see report).
  const compose = `services:
  mariadb:
    image: mariadb:11
    environment:
      MARIADB_ROOT_PASSWORD: "${rootPw}"
      MARIADB_DATABASE: app
    volumes: [mdata:/var/lib/mysql]
  redis:
    image: redis:7-alpine
    volumes: [rdata:/data]
volumes:
  mdata: {}
  rdata: {}
`;
  await ctx.sdk.stacks.deploy({ name: stack, compose_source: compose });
  const out: string[] = [];
  try {
    const mdb = `${stack}_mariadb`;
    const rds = `${stack}_redis`;
    await running(ctx, mdb);
    await running(ctx, rds);
    const sql = (q: string, db = 'app') => ctx.execIn(mdb, `mariadb -uroot -p"$P" -N -e "${q}" ${db}`, { env: { P: rootPw } });
    await poll('mariadb accepting connections', () => sql('SELECT 1'), { timeoutMs: 4 * 60_000, intervalMs: 5000 });
    await sql(`CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(64)); INSERT INTO t VALUES (1,'${marker}'),(2,'two'),(3,'three')`);
    await ctx.execIn(rds, `redis-cli SET e2e:key ${marker} >/dev/null && redis-cli RPUSH e2e:list a b c >/dev/null && redis-cli SAVE`);

    // MariaDB: logical dump → restore as a copy (renamed databases on the same server).
    const mb = await ctx.m<{ snapshotId: string; sizeBytes: number; tool: string; databases: string[] }>(
      'backups.appDb.backupNow', { stack, service: mdb, targetId }, 10 * 60_000,
    );
    log(`mariadb dump ${mb.snapshotId} via ${mb.tool} (${mb.sizeBytes}B, dbs ${mb.databases?.join(',')})`);
    assert(mb.snapshotId, 'mariadb backupNow returned no snapshotId');
    const mr = await ctx.m<{ databases: string[]; mode: string }>(
      'backups.appDb.restore', { stack, service: mdb, snapshotId: mb.snapshotId, mode: 'copy', targetId }, 10 * 60_000,
    );
    const copyDb = (mr.databases ?? []).find((d) => d.startsWith('app_copy')) ?? (mr.databases ?? [])[0];
    assert(copyDb, `mariadb restore returned no databases: ${JSON.stringify(mr)}`);
    const rowsBack = (await sql('SELECT v FROM t ORDER BY id', copyDb)).trim().split('\n');
    assert(rowsBack[0] === marker && rowsBack.length === 3, `copy db ${copyDb} has ${JSON.stringify(rowsBack)}`);
    out.push(`mariadb → ${copyDb} (3 rows)`);

    // Redis: RDB dump → restore as a copy (a new volume holding the RDB).
    const rb = await ctx.m<{ snapshotId: string; sizeBytes: number; tool: string }>(
      'backups.appDb.backupNow', { stack, service: rds, targetId }, 10 * 60_000,
    );
    log(`redis dump ${rb.snapshotId} via ${rb.tool} (${rb.sizeBytes}B)`);
    const rr = await ctx.m<{ volume: string }>(
      'backups.appDb.restore', { stack, service: rds, snapshotId: rb.snapshotId, mode: 'copy', targetId }, 10 * 60_000,
    );
    assert(rr.volume, `redis restore returned no volume: ${JSON.stringify(rr)}`);
    // Boot a throwaway redis on the restored volume, wherever it landed.
    let got = '';
    for (const n of ctx.cluster.nodes) {
      const has = await ctx.cluster.sh(n, `docker volume inspect ${rr.volume} >/dev/null 2>&1`);
      if (has.code !== 0) continue;
      got = await ctx.cluster.mustSh(
        n,
        `docker run --rm -v ${rr.volume}:/data redis:7-alpine sh -c 'redis-server --dir /data --daemonize yes >/dev/null; sleep 2; redis-cli GET e2e:key; redis-cli LLEN e2e:list'`,
        { timeoutMs: 180_000 },
      );
      break;
    }
    const [k, len] = got.trim().split('\n');
    assert(k === marker && len === '3', `restored redis volume ${rr.volume}: key=${k} llen=${len}`);
    out.push(`redis → volume ${rr.volume} (key + list intact)`);
    return out.join('; ');
  } finally {
    if (!ctx.opts.keep) await ctx.sdk.stacks.remove(stack).catch(() => {});
  }
}
