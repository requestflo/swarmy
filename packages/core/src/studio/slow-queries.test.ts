import { describe, expect, it } from 'bun:test';
import { classifySql } from './classify';
import { aggregateSlowQueries, parseSnapshotRows, pgSlowSnapshotSql, snapshotDeltas, spreadMs, type StatementTotals } from './slow-queries';

const tot = (queryId: string, calls: number, totalMs: number, more: Partial<StatementTotals> = {}): StatementTotals => ({ queryId, calls, totalMs, rows: calls, query: `q${queryId}`, ...more });
const map = (xs: StatementTotals[]) => new Map(xs.map((x) => [x.queryId, x]));

/** What pg_stat_statements reports after these calls (population stddev), as the snapshot SQL reads it. */
function cumulative(queryId: string, times: number[]): StatementTotals {
  const n = times.length;
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(times.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  return tot(queryId, n, mean * n, { sumSqMs2: n * (sd ** 2 + mean ** 2), maxMs: Math.max(...times) });
}

describe('pg_stat_statements snapshot → deltas', () => {
  it('the snapshot is one bounded read the studio classifies as a read, with the spread and max columns', () => {
    const sql = pgSlowSnapshotSql();
    expect(classifySql(sql, 'postgres').class).toBe('read');
    expect(sql).toContain('LIMIT 200');
    expect(sql).toContain('power(stddev_exec_time, 2) + power(mean_exec_time, 2)');
    expect(sql).toContain('max(max_exec_time)');
  });

  it('parses the result grid, skipping malformed rows; an old grid without the new columns reads them as null', () => {
    const r = { columns: ['queryid', 'calls', 'total_ms', 'rows', 'query', 'sumsq_ms2', 'max_ms'], rows: [['-42', '10', '12.5', '10', 'SELECT 1', '20.25', '3.1'], [null, '1', '1', '1', 'x', null, null]] };
    expect(parseSnapshotRows(r)).toEqual([{ queryId: '-42', calls: 10, totalMs: 12.5, rows: 10, query: 'SELECT 1', sumSqMs2: 20.25, maxMs: 3.1 }]);
    const old = { columns: ['queryid', 'calls', 'total_ms', 'rows', 'query'], rows: [['7', '1', '2', '1', 'q']] };
    expect(parseSnapshotRows(old)[0]).toMatchObject({ sumSqMs2: null, maxMs: null });
  });

  it('first snapshot is only a baseline', () => {
    expect(snapshotDeltas(null, [tot('1', 10, 100)])).toEqual([]);
  });

  it('subtracts the previous totals (sum of squares too), carries the max, drops idle statements', () => {
    const d = snapshotDeltas(
      map([tot('1', 10, 100, { sumSqMs2: 1200, maxMs: 30 }), tot('2', 5, 50)]),
      [tot('1', 14, 180, { sumSqMs2: 2900, maxMs: 41 }), tot('2', 5, 50)],
    );
    expect(d).toEqual([{ queryId: '1', calls: 4, totalMs: 80, rows: 4, query: 'q1', sumSqMs2: 1700, maxMs: 41 }]);
    expect(snapshotDeltas(map([tot('1', 10, 100)]), [tot('1', 14, 180, { sumSqMs2: 2900 })])[0]!.sumSqMs2).toBeNull();
  });

  it('a reset (counters went down) counts the whole current total', () => {
    expect(snapshotDeltas(map([tot('1', 100, 1000)]), [tot('1', 3, 9, { sumSqMs2: 27, maxMs: 3 })])).toEqual([
      { queryId: '1', calls: 3, totalMs: 9, rows: 3, query: 'q1', sumSqMs2: 27, maxMs: 3 },
    ]);
  });

  it('a new statement counts only when the previous snapshot saw everything', () => {
    expect(snapshotDeltas(map([tot('1', 1, 1)]), [tot('9', 2, 4)])).toHaveLength(1);
    expect(snapshotDeltas(map([tot('1', 1, 1)]), [tot('9', 2, 4)], { limit: 1 })).toEqual([]);
  });
});

describe('24 h aggregate — mean and spread exact, the slowest call as Postgres records it, no percentile', () => {
  it('spreadMs is the population standard deviation from n, Σx and Σx²', () => {
    expect(spreadMs(3, 60, 100 + 400 + 900)).toBeCloseTo(8.165, 3);
    expect(spreadMs(2, 10, 50)).toBe(0);
    expect(spreadMs(3, 60, null)).toBeNull();
  });

  it('the spread of the window’s calls alone, from two cumulative snapshots', () => {
    const before = [5, 7, 400];
    const window = [10, 12, 14, 900, 11];
    const [d] = snapshotDeltas(map([cumulative('a', before)]), [cumulative('a', [...before, ...window])]);
    const [row] = aggregateSlowQueries([d!], new Map());
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, x) => a + (x - mean) ** 2, 0) / window.length);
    expect(row!.meanMs).toBe(Math.round(mean * 100) / 100);
    expect(row!.stddevMs).toBe(Math.round(sd * 100) / 100);
    expect(row!.maxMs).toBe(900);
  });

  it('sums calls and time per statement, slowest total first; the max is the newest reading', () => {
    const rows = aggregateSlowQueries(
      [
        { queryId: 'a', calls: 90, totalMs: 900, rows: 90, sumSqMs2: 90 * 100, maxMs: 300 },
        { queryId: 'a', calls: 10, totalMs: 4000, rows: 10, sumSqMs2: 10 * 400 ** 2, maxMs: 450 },
        { queryId: 'b', calls: 1, totalMs: 50, rows: 0 },
      ],
      new Map([['a', 'SELECT * FROM orders WHERE id = $1']]),
    );
    expect(rows).toEqual([
      { queryId: 'a', query: 'SELECT * FROM orders WHERE id = $1', calls: 100, totalMs: 4900, meanMs: 49, stddevMs: 117, maxMs: 450, rows: 100, samples: 2 },
      { queryId: 'b', query: '', calls: 1, totalMs: 50, meanMs: 50, stddevMs: null, maxMs: null, rows: 0, samples: 1 },
    ]);
  });

  it('a window with a snapshot taken before the spread was read has no spread, not a partial one', () => {
    const [row] = aggregateSlowQueries([{ queryId: 'a', calls: 5, totalMs: 50, rows: 5 }, { queryId: 'a', calls: 5, totalMs: 50, rows: 5, sumSqMs2: 500 }], new Map());
    expect(row!.stddevMs).toBeNull();
  });
});
