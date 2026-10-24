import { describe, expect, it } from 'bun:test';
import { DB_CLUSTER_NAME_MAX, restoreCopyName } from './db-restore-copy';

const OCT_24 = new Date('2026-10-24T22:30:00Z');

describe('restoreCopyName — the new database a copy restore creates', () => {
  it('is <cluster>-restore-<mmdd> by the UTC date', () => {
    expect(restoreCopyName('main', OCT_24)).toBe('main-restore-1024');
    expect(restoreCopyName('main', new Date('2026-03-05T00:10:00Z'))).toBe('main-restore-0305');
  });

  it('never reuses a name that is taken', () => {
    expect(restoreCopyName('main', OCT_24, ['main', 'main-restore-1024'])).toBe('main-restore-1024-2');
    expect(restoreCopyName('main', OCT_24, ['main-restore-1024', 'main-restore-1024-2'])).toBe('main-restore-1024-3');
  });

  it('cuts a long source name so the copy still fits, never ending on a dash', () => {
    const long = 'orders-and-invoices-ledger-primary-db'; // 37 chars
    const name = restoreCopyName(long, OCT_24);
    expect(name.length).toBeLessThanOrEqual(DB_CLUSTER_NAME_MAX);
    expect(name).toBe('orders-and-invoices-ledger-restore-1024');
    const again = restoreCopyName(long, OCT_24, [name]);
    expect(again).toBe('orders-and-invoices-ledge-restore-1024-2');
    expect(again.length).toBe(DB_CLUSTER_NAME_MAX);
  });
});
