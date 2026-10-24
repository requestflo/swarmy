import { describe, expect, it } from 'bun:test';
import type { DbPitrWindowResult } from '@swarmy/core/protocol';
import { judgePitrTarget, plainTime, windowWords } from './dbPitrWindow.judge';

/** A PITR target outside the window the agent read is refused, in plain words, naming the window. */

const READ: DbPitrWindowResult = {
  backups: [
    { name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' },
    { name: 'base_000000010000000000000009', finishTime: '2026-10-22T03:00:00.000Z' },
  ],
  window: { from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:15:00.000Z' },
  latestWalAt: '2026-10-24T09:15:00.000Z',
  checkedAt: '2026-10-24T09:20:00.000Z',
};
const ask = (over: Partial<Parameters<typeof judgePitrTarget>[1]> = {}) => ({ ref: 'shop/main', ...over });

describe('windowWords', () => {
  it('says the window, where it starts and why', () => {
    expect(windowWords('shop/main', READ)).toBe(
      'shop/main can be restored to any time from 2026-10-20 03:00:00 UTC (when its oldest base backup, ' +
        'base_000000010000000000000002, finished) to 2026-10-24 09:15:00 UTC (its newest archived change).',
    );
  });
  it('without a WAL listing the end is when swarmy checked', () => {
    expect(windowWords('shop/main', { ...READ, latestWalAt: undefined })).toContain('(when swarmy checked)');
  });
  it('no base backups: no window, and what to do', () => {
    expect(windowWords('shop/main', { backups: [], window: null, checkedAt: 'x' })).toBe(
      'shop/main has no base backups yet, so there is no point in time to restore it to. Take a base backup first.',
    );
  });
});

describe('judgePitrTarget', () => {
  it('a time inside the window passes, ends included', () => {
    expect(judgePitrTarget(READ, ask({ targetTime: '2026-10-21T12:00:00Z' }))).toBeNull();
    expect(judgePitrTarget(READ, ask({ targetTime: '2026-10-20T03:00:00Z' }))).toBeNull();
    expect(judgePitrTarget(READ, ask({ targetTime: '2026-10-24T09:15:00Z' }))).toBeNull();
  });
  it('before the oldest base backup finished: refused with the window', () => {
    const msg = judgePitrTarget(READ, ask({ targetTime: '2026-10-19T00:00:00Z' }));
    expect(msg).toStartWith('Nothing was restored, saved or stopped: 2026-10-19 00:00:00 UTC is before the oldest base backup of shop/main finished.');
    expect(msg).toContain('any time from 2026-10-20 03:00:00 UTC');
  });
  it('after the newest archived change (or the future): refused with the window', () => {
    expect(judgePitrTarget(READ, ask({ targetTime: '2026-10-24T10:00:00Z' }))).toContain('is after its newest archived change.');
    expect(judgePitrTarget({ ...READ, latestWalAt: undefined, window: { ...READ.window!, to: READ.checkedAt } }, ask({ targetTime: '2026-11-01T00:00:00Z' }))).toContain(
      'is after the time swarmy checked.',
    );
  });
  it('no base backups at all: refused, with or without a target', () => {
    const none: DbPitrWindowResult = { backups: [], window: null, checkedAt: 'x' };
    expect(judgePitrTarget(none, ask())).toContain('has no base backups yet');
    expect(judgePitrTarget(none, ask({ targetTime: '2026-10-21T00:00:00Z' }))).toContain('has no base backups yet');
  });
  it('no target replays everything from the latest base backup: fine when one exists', () => {
    expect(judgePitrTarget(READ, ask({ snapshotId: 'latest' }))).toBeNull();
  });
  it('a named base backup must exist, and the target cannot be before it finished', () => {
    expect(judgePitrTarget(READ, ask({ snapshotId: 'base_0000000100000000000000FF' }))).toContain('there is no base backup named base_0000000100000000000000FF.');
    const early = judgePitrTarget(READ, ask({ snapshotId: 'base_000000010000000000000009', targetTime: '2026-10-21T00:00:00Z' }));
    expect(early).toContain('before the base backup base_000000010000000000000009 finished (2026-10-22 03:00:00 UTC)');
    expect(judgePitrTarget(READ, ask({ snapshotId: 'base_000000010000000000000009', targetTime: '2026-10-23T00:00:00Z' }))).toBeNull();
  });
  it('a target that is not a time is refused before anything happens', () => {
    expect(judgePitrTarget(READ, ask({ targetTime: 'yesterday' }))).toContain('"yesterday" is not a time.');
  });
});

describe('plainTime', () => {
  it('UTC to the second; a non-time stays as typed', () => {
    expect(plainTime('2026-10-20T03:00:00.456Z')).toBe('2026-10-20 03:00:00 UTC');
    expect(plainTime('soon')).toBe('soon');
  });
});
