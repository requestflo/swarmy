import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { openSqlite } from './bun-sqlite-adapter';
import { createTestDb, type TestDb } from './testing';

// The adapter against the real schema (both baselines), through Prisma.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function org(slug: string) {
  return t.db.organization.create({ data: { id: `org_${slug}`, name: slug, slug } });
}

describe('bun:sqlite adapter', () => {
  it('opens with WAL, NORMAL sync, foreign keys and a busy timeout', () => {
    const raw = openSqlite(t.controlPath, {});
    // journal_mode is persistent in the file; the others are per-connection, so
    // read them back through Prisma's own handle.
    expect(raw.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();
  });

  it('reports the per-connection PRAGMAs on the Prisma handle', async () => {
    const rows = await t.db.$queryRawUnsafe<Record<string, bigint>[]>('PRAGMA foreign_keys');
    expect(Number(Object.values(rows[0]!)[0])).toBe(1);
    const bt = await t.db.$queryRawUnsafe<Record<string, bigint>[]>('PRAGMA busy_timeout');
    expect(Number(Object.values(bt[0]!)[0])).toBe(5000);
    const sync = await t.db.$queryRawUnsafe<Record<string, bigint>[]>('PRAGMA synchronous');
    expect(Number(Object.values(sync[0]!)[0])).toBe(1); // NORMAL
  });

  it('applies Json defaults (the quoted DDL) and round-trips Json values', async () => {
    const o = await org('json');
    const key = await t.db.apiKey.create({ data: { orgId: o.id, name: 'k', keyHash: 'h1', prefix: 'p' } });
    expect(key.scopes).toEqual(['read']);
    const log = await t.db.auditLog.create({ data: { orgId: o.id, action: 'a' } });
    expect(log.metadata).toEqual({});
    const upd = await t.db.auditLog.update({
      where: { id: log.id },
      data: { metadata: { nested: { list: [1, 'two', null], ok: true } } },
    });
    expect(upd.metadata).toEqual({ nested: { list: [1, 'two', null], ok: true } });
  });

  it('fills Int autoincrement ids (the rowid alias)', async () => {
    const o = await org('ids');
    const a = await t.db.auditLog.create({ data: { orgId: o.id, action: 'x' } });
    const b = await t.db.auditLog.create({ data: { orgId: o.id, action: 'y' } });
    expect(typeof a.id).toBe('number');
    expect(b.id).toBeGreaterThan(a.id);
    const s = await t.telemetry.metricSample.create({
      data: {
        orgId: o.id,
        nodeId: 'n1',
        scope: 'NODE',
        cpuPercent: 1.5,
        memUsedBytes: 2n ** 40n,
        memTotalBytes: 2n ** 41n,
        netRxBytes: 0n,
        netTxBytes: 0n,
        diskUsedBytes: 0n,
        diskTotalBytes: 0n,
        ts: new Date(),
      },
    });
    expect(s.id).toBe(1);
    expect(s.memUsedBytes).toBe(2n ** 40n);
  });

  it('keeps BigInt precision beyond 2^53', async () => {
    const big = 2n ** 60n + 7n;
    const rows = await t.db.$queryRaw<{ v: bigint }[]>`SELECT ${big} AS v`;
    expect(BigInt(rows[0]!.v)).toBe(big);
  });

  it('maps a unique violation to P2002', async () => {
    await org('dupe');
    await expect(org('dupe')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces foreign keys (P2003) and cascades deletes', async () => {
    await expect(Promise.resolve(t.db.auditLog.create({ data: { orgId: 'org_missing', action: 'z' } }))).rejects.toMatchObject({
      code: 'P2003',
    });
    const o = await org('cascade');
    await t.db.auditLog.create({ data: { orgId: o.id, action: 'c' } });
    await t.db.organization.delete({ where: { id: o.id } });
    expect(await t.db.auditLog.count({ where: { orgId: o.id } })).toBe(0);
  });

  it('rolls back an interactive transaction that throws', async () => {
    await expect(
      t.db.$transaction(async (tx) => {
        await tx.organization.create({ data: { id: 'org_tx', name: 'tx', slug: 'tx' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await t.db.organization.count({ where: { slug: 'tx' } })).toBe(0);
  });

  it('serialises concurrent interactive transactions', async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        t.db.$transaction(async (tx) => {
          await tx.organization.create({ data: { id: `org_c${i}`, name: 'c', slug: `c${i}` } });
          await new Promise((r) => setTimeout(r, 5));
          return tx.organization.count();
        }),
      ),
    );
    expect(await t.db.organization.count({ where: { slug: { startsWith: 'c' } } })).toBe(5);
    await t.db.$transaction([
      t.db.organization.create({ data: { id: 'org_b1', name: 'b', slug: 'b1' } }),
      t.db.organization.create({ data: { id: 'org_b2', name: 'b', slug: 'b2' } }),
    ]);
    expect(await t.db.organization.count({ where: { slug: { in: ['b1', 'b2'] } } })).toBe(2);
  });

  it('orders and filters DateTime correctly (ISO text with a fixed offset)', async () => {
    const o = await org('dates');
    const t0 = new Date('2026-01-01T09:00:00.000Z');
    const t1 = new Date('2026-01-01T10:00:00.000Z');
    await t.db.auditLog.create({ data: { orgId: o.id, action: 'late', ts: t1 } });
    await t.db.auditLog.create({ data: { orgId: o.id, action: 'early', ts: t0 } });
    const rows = await t.db.auditLog.findMany({ where: { orgId: o.id }, orderBy: { ts: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['early', 'late']);
    expect(rows[0]!.ts.getTime()).toBe(t0.getTime());
    expect(
      await t.db.auditLog.count({ where: { orgId: o.id, ts: { gt: new Date('2026-01-01T09:30:00Z') } } }),
    ).toBe(1);
    // @default(now()) is filled by the client in the same format.
    const auto = await t.db.auditLog.create({ data: { orgId: o.id, action: 'now' } });
    expect(Math.abs(auto.ts.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('contains is case-insensitive for ASCII (SQLite LIKE)', async () => {
    await org('CaseMix');
    expect(await t.db.organization.count({ where: { slug: { contains: 'casemix' } } })).toBe(1);
  });

  it('enums store as text and filter', async () => {
    const o = await org('enum');
    await t.telemetry.metricSample.create({
      data: {
        orgId: o.id,
        nodeId: 'n2',
        scope: 'CONTAINER',
        containerId: 'c',
        cpuPercent: 0,
        memUsedBytes: 0n,
        memTotalBytes: 0n,
        netRxBytes: 0n,
        netTxBytes: 0n,
        diskUsedBytes: 0n,
        diskTotalBytes: 0n,
        ts: new Date(),
      },
    });
    expect(await t.telemetry.metricSample.count({ where: { scope: 'CONTAINER' } })).toBe(1);
    const agg = await t.telemetry.metricSample.groupBy({ by: ['scope'], _count: { _all: true } });
    expect(agg.length).toBe(2);
  });
});
