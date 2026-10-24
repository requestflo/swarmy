import { describe, expect, it } from 'bun:test';
import { classifySql } from './classify';
import {
  aggregateSlowQueries,
  parseSnapshotRows,
  pgSlowSnapshotSql,
  snapshotDeltas,
  weightedPercentile,
  type StatementTotals,
} from './slow-queries';

const tot = (queryId: string, calls: number, totalMs: number, rows = calls): StatementTotals => ({ queryId, calls, totalMs, rows, query: `q${queryId}` });
const map = (xs: StatementTotals[]) => new Map(xs.map((x) => [x.queryId, x]));

describe('pg_stat_statements snapshot → deltas', () => {
  it('the snapshot is one bounded read the studio classifies as a read', () => {
    const sql = pgSlowSnapshotSql();
    expect(classifySql(sql, 'postgres').class).toBe('read');
    expect(sql).toContain('LIMIT 200');
  });

  it('parses the result grid, skipping malformed rows', () => {
    const r = { columns: ['queryid', 'calls', 'total_ms', 'rows', 'query'], rows: [['-42', '10', '12.5', '10', 'SELECT 1'], [null, '1', '1', '1', 'x']] };
    expect(parseSnapshotRows(r)).toEqual([{ queryId: '-42', calls: 10, totalMs: 12.5, rows: 10, query: 'SELECT 1' }]);
  });

  it('first snapshot is only a baseline', () => {
    expect(snapshotDeltas(null, [tot('1', 10, 100)])).toEqual([]);
  });

  it('subtracts the previous totals and drops idle statements', () => {
    const d = snapshotDeltas(map([tot('1', 10, 100), tot('2', 5, 50)]), [tot('1', 14, 180), tot('2', 5, 50)]);
    expect(d).toEqual([{ queryId: '1', calls: 4, totalMs: 80, rows: 4, query: 'q1' }]);
  });

  it('a reset (counters went down) counts the whole current total', () => {
    expect(snapshotDeltas(map([tot('1', 100, 1000)]), [tot('1', 3, 9)])).toEqual([{ queryId: '1', calls: 3, totalMs: 9, rows: 3, query: 'q1' }]);
  });

  it('a new statement counts only when the previous snapshot saw everything', () => {
    expect(snapshotDeltas(map([tot('1', 1, 1)]), [tot('9', 2, 4)])).toHaveLength(1);
    expect(snapshotDeltas(map([tot('1', 1, 1)]), [tot('9', 2, 4)], { limit: 1 })).toEqual([]);
  });
});

describe('24 h aggregate (mean exact, p95 estimated from snapshot means)', () => {
  it('weighted percentile', () => {
    expect(weightedPercentile([{ value: 10, weight: 99 }, { value: 500, weight: 1 }], 0.95)).toBe(10);
    expect(weightedPercentile([{ value: 10, weight: 90 }, { value: 500, weight: 10 }], 0.95)).toBe(500);
    expect(weightedPercentile([], 0.95)).toBeNull();
  });

  it('sums calls and time per statement, slowest total first', () => {
    const rows = aggregateSlowQueries(
      [
        { queryId: 'a', calls: 90, totalMs: 900, rows: 90 },
        { queryId: 'a', calls: 10, totalMs: 4000, rows: 10 },
        { queryId: 'b', calls: 1, totalMs: 50, rows: 0 },
      ],
      new Map([['a', 'SELECT * FROM orders WHERE id = $1']]),
    );
    expect(rows).toEqual([
      { queryId: 'a', query: 'SELECT * FROM orders WHERE id = $1', calls: 100, totalMs: 4900, meanMs: 49, p95Ms: 400, rows: 100, samples: 2 },
      { queryId: 'b', query: '', calls: 1, totalMs: 50, meanMs: 50, p95Ms: 50, rows: 0, samples: 1 },
    ]);
  });
});
