import { describe, expect, test } from 'bun:test';
import { memoryChangeWords, memoryLine, memoryWord } from './pg-memory';
import type { PgTopoMember } from './pg-topology';

const MB = 1024 * 1024;
const members = (primaryMb?: number, replicaMb?: number): PgTopoMember[] => [
  { service: 'shop_db-primary', role: 'primary', status: 'running', desired: 1, running: 1, ...(primaryMb ? { memoryMb: primaryMb } : {}) },
  { service: 'shop_db-replica', role: 'replica', status: 'running', desired: 2, running: 2, ...(replicaMb ? { memoryMb: replicaMb } : {}) },
];

describe('memoryWord', () => {
  test('MB under a gigabyte, GB above, and the unlimited case', () => {
    expect([memoryWord(512), memoryWord(2048), memoryWord(1536), memoryWord(null)]).toEqual(['512 MB', '2 GB', '1.5 GB', 'no limit']);
  });
});

describe('memoryLine', () => {
  test('steady: the limit, what the main copy uses, and the derived settings at Controls', () => {
    const l = memoryLine({ name: 'db', memoryMb: 2048, members: members(2048, 2048) }, 612 * MB);
    expect([l.label, l.progress, l.tone]).toEqual(['2 GB per copy', null, 'ok']);
    expect(l.hint).toBe('612 MB in use by the main copy. A quarter of it is Postgres’s own cache.');
    expect(l.tech).toContain('shared_buffers 512MB (25%) · effective_cache_size 1536MB (75%)');
  });

  test('mid-restart: counts copies (not services) already on the new size', () => {
    const l = memoryLine({ name: 'db', memoryMb: 4096, members: members(2048, 4096) }, null);
    expect(l.progress).toEqual({ done: 2, total: 3 });
    expect(l.hint).toBe('Restarting copies for the new size: 2 of 3 done, the standby copies first.');
  });

  test('no limit declared and none applied is steady', () => {
    const l = memoryLine({ name: 'db', members: members() }, null);
    expect([l.label, l.progress]).toEqual(['No limit', null]);
    expect(l.tech).toContain('swarmy.db.memoryMb unset');
  });
});

describe('memoryChangeWords', () => {
  test('says what restarts, in order', () => {
    expect(memoryChangeWords('db', 4096, 3)).toBe('db moves to 4 GB per copy: swarmy restarts the standby copies first, then the main copy in place, a few seconds without writes.');
    expect(memoryChangeWords('db', null, 1)).toBe('db moves to no limit: swarmy restarts it in place, a few seconds without writes.');
  });
});
