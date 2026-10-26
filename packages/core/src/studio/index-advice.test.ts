import { describe, expect, it } from 'bun:test';
import { classifySql } from './classify';
import { indexAdvice, indexCovers } from './index-advice';
import { PG_INDEX_FACTS_SQL, parseIndexFacts, type ForeignKeyStat, type IndexFacts, type IndexStat, type TableStat } from './index-facts';

const MB = 1024 * 1024;
const table = (t: Partial<TableStat> & { table: string }): TableStat => ({ seqScan: 0, seqRead: 0, idxScan: 0, live: 0, bytes: 8 * MB, ...t });
const index = (x: Partial<IndexStat> & { index: string; table: string }): IndexStat => ({ scans: 0, bytes: 16 * MB, enforces: false, ...x });
const fk = (f: Partial<ForeignKeyStat> & { table: string }): ForeignKeyStat => ({ name: 'fk', references: 'carts', keys: [2], columns: ['cart_id'], indexes: [], live: 412_000, ...f });
const facts = (f: Partial<IndexFacts>): IndexFacts => ({ statsReset: '2026-09-01T03:00:00+00:00', tables: [], indexes: [], foreignKeys: [], ...f });

describe('PG_INDEX_FACTS_SQL', () => {
  it('is one read the studio classifier lets through', () => {
    const c = classifySql(PG_INDEX_FACTS_SQL, 'postgres');
    expect([c.class, c.blocked ?? null]).toEqual(['read', null]);
  });
});

describe('indexCovers — an index helps a foreign key only when it leads with its columns', () => {
  it('leading columns, in any order among themselves', () => {
    expect(indexCovers([2], [2])).toBe(true);
    expect(indexCovers([2, 5], [2])).toBe(true);
    expect(indexCovers([5, 2], [2, 5])).toBe(true);
  });
  it('a later column, an expression or a shorter index does not', () => {
    expect(indexCovers([5, 2], [2])).toBe(false);
    expect(indexCovers([0], [0])).toBe(false);
    expect(indexCovers([2], [2, 5])).toBe(false);
    expect(indexCovers([2], [])).toBe(false);
  });
});

describe('indexAdvice', () => {
  it('a foreign key with no index: the exact CREATE INDEX CONCURRENTLY, never run', () => {
    const [tip, ...rest] = indexAdvice(facts({ foreignKeys: [fk({ table: 'order_items', name: 'order_items_cart_id_fkey' })] }));
    expect(rest).toEqual([]);
    expect(tip).toMatchObject({ kind: 'fk-unindexed', sqlKind: 'ready', sql: 'CREATE INDEX CONCURRENTLY ON order_items (cart_id);', head: 'Index order_items.cart_id' });
    expect(tip!.why).toContain('Deleting or changing a row of carts makes Postgres read the whole of order_items');
  });

  it('a foreign key is fine when an index leads with it, a partial one is not counted (the SQL leaves it out), small tables are skipped', () => {
    expect(indexAdvice(facts({ foreignKeys: [fk({ table: 'a', indexes: [[1], [2, 3]] })] }))).toEqual([]);
    expect(indexAdvice(facts({ foreignKeys: [fk({ table: 'a', live: 900 })] }))).toEqual([]);
    const multi = indexAdvice(facts({ foreignKeys: [fk({ table: 'a', keys: [2, 3], columns: ['org_id', '"Cart"'], indexes: [[2]] })] }));
    expect(multi[0]!.sql).toBe('CREATE INDEX CONCURRENTLY ON a (org_id, "Cart");');
  });

  it('a big table read start to finish more than through an index: a template, since the column is unknown', () => {
    const t = table({ table: 'orders', seqScan: 12_400, seqRead: 12_400 * 2_100_000, idxScan: 30, live: 2_100_000 });
    const [tip] = indexAdvice(facts({ tables: [t] }));
    expect(tip).toMatchObject({ kind: 'seq-scans', sqlKind: 'template', sql: 'CREATE INDEX CONCURRENTLY ON orders (/* the column its queries filter by */);' });
    expect(tip!.why).toBe(
      'orders has 2.1M rows and was read start to finish 12k times, but through an index only 30. An index on the column its queries filter by lets Postgres go straight to the rows: the slow queries above show which.',
    );
  });

  it('no scan tip for a small table, a mostly-indexed one, a rarely-scanned one or short scans', () => {
    const base = { table: 'x', seqScan: 500, seqRead: 500 * 50_000, idxScan: 10, live: 50_000 };
    expect(indexAdvice(facts({ tables: [table({ ...base, live: 9_000 })] }))).toEqual([]);
    expect(indexAdvice(facts({ tables: [table({ ...base, idxScan: 600 })] }))).toEqual([]);
    expect(indexAdvice(facts({ tables: [table({ ...base, seqScan: 40, seqRead: 40 * 50_000 })] }))).toEqual([]);
    expect(indexAdvice(facts({ tables: [table({ ...base, seqRead: 500 * 900 })] }))).toEqual([]);
  });

  it('an unused index on a busy table: DROP INDEX CONCURRENTLY, with the standby caveat when there are standbys', () => {
    const f = facts({ tables: [table({ table: 'orders', idxScan: 48_000 })], indexes: [index({ index: 'orders_legacy_idx', table: 'orders', bytes: 48 * MB })] });
    const [tip] = indexAdvice(f);
    expect(tip).toMatchObject({ kind: 'unused-index', sql: 'DROP INDEX CONCURRENTLY orders_legacy_idx;', gain: '48 MB back, and one less index to update on every write' });
    expect(tip!.why).toContain('read 48k times since the statistics were reset on 2026-09-01');
    expect(tip!.why).not.toContain('Standby');
    expect(indexAdvice(f, { standbys: true })[0]!.why).toContain('if your app reads from a standby, check there before dropping it');
    expect(indexAdvice({ ...f, statsReset: null })[0]!.why).toContain('since its statistics began');
  });

  it('never suggests dropping a constraint’s index, a used one, a tiny one, or one on a quiet table', () => {
    const t = table({ table: 'orders', idxScan: 48_000 });
    const keep = [
      index({ index: 'orders_pkey', table: 'orders', enforces: true }),
      index({ index: 'orders_used', table: 'orders', scans: 3 }),
      index({ index: 'orders_tiny', table: 'orders', bytes: 64 * 1024 }),
      index({ index: 'quiet_idx', table: 'quiet' }),
    ];
    expect(indexAdvice(facts({ tables: [t, table({ table: 'quiet', idxScan: 20 })], indexes: keep }))).toEqual([]);
  });
});

describe('parseIndexFacts', () => {
  it('reads the one JSON cell; anything malformed is nothing', () => {
    const cell = JSON.stringify({
      reset: null,
      tables: [{ tbl: 'orders', seq_scan: 5, seq_tup_read: 50, idx_scan: 2, live: 10, bytes: 8192 }],
      indexes: [{ idx: 'orders_pkey', tbl: 'orders', idx_scan: 9, bytes: 16384, enforces: true }],
      fks: [{ tbl: 'order_items', name: 'fk1', ref: 'orders', keys: [2], cols: ['order_id'], idx_keys: ['1', '2 3'], live: 40 }],
    });
    const f = parseIndexFacts({ rows: [[cell]] });
    expect(f.statsReset).toBeNull();
    expect(f.tables[0]).toEqual({ table: 'orders', seqScan: 5, seqRead: 50, idxScan: 2, live: 10, bytes: 8192 });
    expect(f.indexes[0]).toEqual({ index: 'orders_pkey', table: 'orders', scans: 9, bytes: 16384, enforces: true });
    expect(f.foreignKeys[0]).toEqual({ table: 'order_items', name: 'fk1', references: 'orders', keys: [2], columns: ['order_id'], indexes: [[1], [2, 3]], live: 40 });
    expect(parseIndexFacts({ rows: [['not json']] })).toEqual({ statsReset: null, tables: [], indexes: [], foreignKeys: [] });
    expect(parseIndexFacts({ rows: [] }).tables).toEqual([]);
  });
});
