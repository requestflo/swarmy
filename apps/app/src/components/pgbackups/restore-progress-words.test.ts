import { describe, expect, it } from 'bun:test';
import type { DbRestoreProgressView } from '@swarmy/core';
import { runTitle, stepDetail, stepWords } from './restore-progress-words';

const run = (over: Partial<DbRestoreProgressView> = {}): DbRestoreProgressView => ({
  ref: 'shop/db',
  into: 'shop/db-restore-1026',
  mode: 'pitr',
  engine: 'wal-g',
  targetTime: '2026-10-24T13:10:00.000Z',
  startedAt: 0,
  endedAt: null,
  status: 'running',
  error: null,
  done: [],
  current: { stage: 'base', startedAt: 0 },
  bytesDone: null,
  bytesTotal: null,
  percent: null,
  segments: null,
  replayedTo: null,
  ...over,
});

describe('restore progress words', () => {
  it('names each step in plain words, with the database it lands in', () => {
    expect(stepWords('create', run())).toBe('Creating db-restore-1026');
    expect(stepWords('replay', run())).toBe('Replaying the changes');
  });

  it('the numbers for the step running now', () => {
    expect(stepDetail(run({ bytesDone: 1024 ** 3, bytesTotal: 4 * 1024 ** 3 }))).toBe('1.0 GB of 4.0 GB · 25%');
    expect(stepDetail(run({ current: { stage: 'download', startedAt: 0 }, bytesDone: 512, percent: 12.7 }))).toBe('512 B · 12%');
    expect(stepDetail(run({ current: { stage: 'wal', startedAt: 0 }, segments: 1 }))).toBe('1 segment');
    expect(stepDetail(run({ current: { stage: 'replay', startedAt: 0 }, replayedTo: '2026-10-24T13:05:22.000Z' }))).toBe('up to 13:05:22 of 13:10:00 UTC');
    expect(stepDetail(run({ current: { stage: 'replay', startedAt: 0 } }))).toBe('to 13:10:00 UTC');
    expect(stepDetail(run())).toBeNull();
  });

  it('the heading says where it is going, or how it ended', () => {
    expect(runTitle(run())).toBe('Restoring db-restore-1026 to Sat 24 Oct · 13:10:00 UTC');
    expect(runTitle(run({ mode: 'in-place', targetTime: null, into: 'shop/db' }))).toBe('Restoring db');
    expect(runTitle(run({ status: 'failed' }))).toBe('The restore into db-restore-1026 stopped');
  });
});
