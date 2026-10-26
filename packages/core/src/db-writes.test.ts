import { describe, expect, it } from 'bun:test';
import { dbWritesFromMeta, dbWritesSince, parseDbWrites } from './db-writes';

describe('db write counters', () => {
  it('reads one result row, cells as numbers or strings, and refuses anything else', () => {
    expect(parseDbWrites(['12345', 1761400000, '0'])).toEqual({ rows: 12345, serverStart: 1761400000, statsReset: 0 });
    expect(parseDbWrites([])).toBeNull();
    expect(parseDbWrites(undefined)).toBeNull();
    expect(parseDbWrites(['12', 'x', '0'])).toBeNull();
    expect(parseDbWrites(['-1', '5', '0'])).toBeNull();
    expect(parseDbWrites([null, '5', '0'])).toBeNull();
  });

  it('reads the counters a save’s audit row recorded', () => {
    const writes = { rows: 98, serverStart: 1761400000, statsReset: 1761300000 };
    expect(dbWritesFromMeta({ engine: 'pg_dump', writes })).toEqual(writes);
    expect(dbWritesFromMeta({ engine: 'pg_dump' })).toBeNull();
    expect(dbWritesFromMeta(null)).toBeNull();
    expect(dbWritesFromMeta({ writes: { rows: 'lots' } })).toBeNull();
  });

  it('counts the rows since, or says the counters started again', () => {
    const then = { rows: 1000, serverStart: 10, statsReset: 0 };
    expect(dbWritesSince(then, { rows: 13_500, serverStart: 10, statsReset: 0 })).toEqual({ status: 'counted', rows: 12_500 });
    expect(dbWritesSince(then, { rows: 13_500, serverStart: 11, statsReset: 0 })).toEqual({ status: 'reset' });
    expect(dbWritesSince(then, { rows: 13_500, serverStart: 10, statsReset: 5 })).toEqual({ status: 'reset' });
    expect(dbWritesSince(then, { rows: 10, serverStart: 10, statsReset: 0 })).toEqual({ status: 'reset' });
  });
});
