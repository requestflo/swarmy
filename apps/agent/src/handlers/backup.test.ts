import { describe, expect, it } from 'bun:test';
import { forgetArgsFor, parseForgetRemoved } from './backup';

describe('forgetArgsFor (retention → restic forget invocation)', () => {
  it('builds --keep-within <N>d --prune scoped to the backup tags + host', () => {
    expect(
      forgetArgsFor({
        retentionDays: 30,
        tags: ['org:o1', 'volume:shop_db-data'],
        host: 'shop_db-data',
      }),
    ).toEqual([
      'forget',
      '--keep-within',
      '30d',
      '--prune',
      '--json',
      '--tag',
      'org:o1,volume:shop_db-data',
      '--host',
      'shop_db-data',
    ]);
  });

  it('joins ALL tags into ONE --tag value (AND) — repeated --tag flags would OR-match and forget other volumes', () => {
    const args = forgetArgsFor({ retentionDays: 7, tags: ['org:o1', 'db:shop/main', 'engine:pg_dump'] });
    const tagFlags = args!.filter((a) => a === '--tag');
    expect(tagFlags).toHaveLength(1);
    expect(args![args!.indexOf('--tag') + 1]).toBe('org:o1,db:shop/main,engine:pg_dump');
  });

  it('never prunes without an explicit retentionDays', () => {
    expect(forgetArgsFor({ tags: ['org:o1', 'volume:v'], host: 'v' })).toBeNull();
    expect(forgetArgsFor({ retentionDays: undefined, tags: [] })).toBeNull();
  });

  it('omits --tag/--host when the backup carried none (still bounded by --keep-within)', () => {
    expect(forgetArgsFor({ retentionDays: 14, tags: [] })).toEqual([
      'forget',
      '--keep-within',
      '14d',
      '--prune',
      '--json',
    ]);
  });
});

describe('parseForgetRemoved (restic forget --json output)', () => {
  it('sums removed snapshots across groups, ignoring prune progress noise', () => {
    const out = [
      JSON.stringify([
        { tags: null, host: 'v1', paths: ['/data'], keep: [{ id: 'a' }], remove: [{ id: 'b' }, { id: 'c' }] },
        { tags: null, host: 'v2', paths: ['/data'], keep: [{ id: 'd' }], remove: null },
      ]),
      'repository contains 5 packs',
      'removed 2 old cache directories',
    ].join('\n');
    expect(parseForgetRemoved(out)).toBe(2);
  });

  it('returns 0 when nothing aged out', () => {
    expect(parseForgetRemoved(JSON.stringify([{ keep: [{ id: 'a' }], remove: [] }]))).toBe(0);
  });

  it('returns 0 on empty or non-JSON output', () => {
    expect(parseForgetRemoved('')).toBe(0);
    expect(parseForgetRemoved('unable to open repo')).toBe(0);
  });
});
