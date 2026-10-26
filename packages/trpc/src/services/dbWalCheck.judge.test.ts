import { describe, expect, it } from 'bun:test';
import type { DbWalVerifyResult } from '@swarmy/core/protocol';
import { gapWords, judgeWalTarget, walCheckView, walGaps } from './dbWalCheck.judge';

/**
 * A lost WAL segment stops every replay that reaches it: the view names the
 * gap with a time on each end, and a restore target from the gap up to the
 * next base backup is out of reach. Segments still on their way are not a gap.
 */

const FOUND_1 = { timeline: 1, startSegment: 'S02', endSegment: 'S09', segments: 8, status: 'found' as const, from: '2026-10-20T02:00:00.000Z', to: '2026-10-21T13:10:00.000Z' };
const LOST = { timeline: 1, startSegment: 'S0A', endSegment: 'S0B', segments: 2, status: 'lost' as const, from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z' };
const FOUND_2 = { timeline: 1, startSegment: 'S0C', endSegment: 'S40', segments: 53, status: 'found' as const, from: '2026-10-21T13:25:00.000Z', to: '2026-10-24T09:15:00.000Z' };
const UPLOADING = { timeline: 1, startSegment: 'S41', endSegment: 'S41', segments: 1, status: 'uploading' as const, from: '2026-10-24T09:15:00.000Z' };
const BACKUPS = [
  { name: 'base_A', startTime: '2026-10-20T01:58:00.000Z', finishTime: '2026-10-20T02:00:00.000Z' },
  { name: 'base_B', startTime: '2026-10-22T02:58:00.000Z', finishTime: '2026-10-22T03:00:00.000Z' },
];
const read = (ranges: DbWalVerifyResult['ranges'], backups = BACKUPS): DbWalVerifyResult => ({
  integrity: ranges.some((r) => r.status === 'lost') ? 'failure' : 'ok',
  ranges,
  timeline: { status: 'ok', current: 1, highestInStorage: 1 },
  backups,
  checkedAt: '2026-10-24T09:20:00.000Z',
});

describe('walCheckView', () => {
  it('continuous: since the first archived change, nothing lost, the newest upload as the end', () => {
    const v = walCheckView({ status: 'read', result: read([FOUND_1, UPLOADING]) });
    expect(v).toEqual({
      source: 'agent',
      status: 'continuous',
      continuousSince: '2026-10-20T02:00:00.000Z',
      latestWalAt: '2026-10-21T13:10:00.000Z',
      gaps: [],
      pendingSegments: 1,
      timeline: 'ok',
      checkedAt: '2026-10-24T09:20:00.000Z',
    });
  });

  it('a gap: named with both ends, continuous again from the change after it, reachable again from the next base backup', () => {
    const v = walCheckView({ status: 'read', result: read([FOUND_1, LOST, FOUND_2]) });
    expect(v.status).toBe('gaps');
    expect(v.continuousSince).toBe('2026-10-21T13:25:00.000Z');
    expect(v.gaps).toEqual([
      { from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z', segments: 2, startSegment: 'S0A', endSegment: 'S0B', reachableAgainAt: '2026-10-22T03:00:00.000Z' },
    ]);
  });

  it('no read is none; an older agent is unsupported; neither claims anything', () => {
    expect(walCheckView(null)).toMatchObject({ source: 'none', status: null, gaps: [] });
    expect(walCheckView({ status: 'unsupported', reason: 'old' })).toMatchObject({ source: 'unsupported', status: null });
  });
});

describe('walGaps', () => {
  it('a gap with no base backup taken after it stays out of reach (reachableAgainAt null)', () => {
    expect(walGaps(read([FOUND_1, LOST, FOUND_2], [BACKUPS[0]!]))[0]!.reachableAgainAt).toBeNull();
  });
  it('a base backup that started before the gap ended does not bridge it', () => {
    const straddles = [{ name: 'base_X', startTime: '2026-10-21T13:20:00.000Z', finishTime: '2026-10-21T13:40:00.000Z' }];
    expect(walGaps(read([FOUND_1, LOST, FOUND_2], straddles))[0]!.reachableAgainAt).toBeNull();
  });
});

describe('judgeWalTarget', () => {
  const gaps = walGaps(read([FOUND_1, LOST, FOUND_2]));
  it('refuses a time inside the gap, and after it until the next base backup, in plain words', () => {
    expect(judgeWalTarget('shop/main', gaps, '2026-10-21T13:15:00Z')).toBe(
      'Nothing was restored, saved or stopped: 2026-10-21 13:15:00 UTC is out of reach. The WAL archive of shop/main has a gap ' +
        'from 2026-10-21 13:10:00 UTC to 2026-10-21 13:25:00 UTC (2 segments missing), so a replay stops there. ' +
        'Times from 2026-10-22 03:00:00 UTC on start from the base backup taken after it. Pick a time before the gap or after that backup.',
    );
    expect(judgeWalTarget('shop/main', gaps, '2026-10-21T20:00:00Z')).toContain('is out of reach');
  });
  it('allows a time before the gap, after the next base backup, or no time at all', () => {
    expect(judgeWalTarget('shop/main', gaps, '2026-10-21T13:00:00Z')).toBeNull();
    expect(judgeWalTarget('shop/main', gaps, '2026-10-22T03:00:00Z')).toBeNull();
    expect(judgeWalTarget('shop/main', gaps, undefined)).toBeNull();
  });
  it('an open gap (no base backup since) refuses everything after it', () => {
    const open = walGaps(read([FOUND_1, LOST, FOUND_2], [BACKUPS[0]!]));
    expect(judgeWalTarget('shop/main', open, '2026-10-24T09:00:00Z')).toContain('Nothing after it can be reached until a new base backup is taken.');
  });
  it('gapWords says when an end is unknown', () => {
    expect(gapWords({ ...gaps[0]!, to: null })).toBe('from 2026-10-21 13:10:00 UTC to now (nothing archived after it yet)');
  });
});
