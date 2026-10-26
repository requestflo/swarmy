import { describe, expect, it } from 'bun:test';
import type { DbWalCheckView } from '@swarmy/core';
import { walGapProblems, type WalGapSignal } from './resilience.wal-gaps';

/**
 * Resilience check `wal-gap`: an open gap in a PITR cluster's WAL archive
 * (no base backup since) is crit in production and warn elsewhere; a gap a
 * newer base backup bridged only loses the times inside it (info); a newer
 * timeline in the archive than the database's own is a warn.
 */

const check = (over: Partial<DbWalCheckView> = {}): DbWalCheckView => ({
  source: 'agent',
  status: 'gaps',
  continuousSince: '2026-10-21T13:25:00.000Z',
  latestWalAt: '2026-10-24T09:15:00.000Z',
  gaps: [{ from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z', segments: 2, startSegment: 'S0A', endSegment: 'S0B', reachableAgainAt: null }],
  pendingSegments: 0,
  timeline: 'ok',
  checkedAt: '2026-10-24T09:20:00.000Z',
  ...over,
});
const sig = (production: boolean, c: DbWalCheckView): WalGapSignal => ({ clusters: [{ stack: 'shop', cluster: 'main', production, check: c }] });

describe('walGapProblems', () => {
  it('an open gap in production is crit, with the gap in plain words and a fix on the app\'s Backups tab', () => {
    expect(walGapProblems(sig(true, check()))).toEqual([
      {
        id: 'wal-gap/shop/main/0',
        check: 'wal-gap',
        severity: 'crit',
        title: "shop/main can't be restored to any time after a WAL gap",
        detail: '2 WAL segments are missing from the archive, from 2026-10-21 13:10:00 UTC to 2026-10-21 13:25:00 UTC. Replay stops at the gap, and no base backup has been taken since.',
        fixHint: 'Take a base backup now: restores after it start from it, past the gap.',
        fixLabel: 'Back it up now',
        fixPath: '/stacks/shop/backups',
        resource: 'shop/main',
      },
    ]);
  });

  it('an open gap elsewhere is warn; a bridged one is info', () => {
    expect(walGapProblems(sig(false, check()))[0]!.severity).toBe('warn');
    const bridged = check({ gaps: [{ ...check().gaps[0]!, reachableAgainAt: '2026-10-22T03:00:00.000Z' }] });
    const [p] = walGapProblems(sig(true, bridged));
    expect(p!.severity).toBe('info');
    expect(p!.title).toBe("shop/main has a WAL gap a restore can't land inside");
  });

  it('a continuous archive raises nothing; a timeline split is a warn of its own', () => {
    expect(walGapProblems(sig(true, check({ status: 'continuous', gaps: [] })))).toEqual([]);
    const split = walGapProblems(sig(false, check({ status: 'continuous', gaps: [], timeline: 'failure' })));
    expect(split.map((p) => [p.id, p.severity])).toEqual([['wal-gap/shop/main/timeline', 'warn']]);
  });

  it('no signal (not gathered) raises nothing', () => {
    expect(walGapProblems(undefined)).toEqual([]);
  });
});
