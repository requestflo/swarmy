import { describe, expect, it } from 'bun:test';
import type { DbWalCheckView } from '@swarmy/core';
import { isBlocked, walBlocked, walLine } from './wal-check';

const GAP = { from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z', segments: 2, startSegment: 'A', endSegment: 'B', reachableAgainAt: null };
const view = (over: Partial<DbWalCheckView> = {}): DbWalCheckView => ({
  source: 'agent',
  status: 'continuous',
  continuousSince: '2026-10-21T02:00:00.000Z',
  latestWalAt: '2026-10-24T09:15:00.000Z',
  gaps: [],
  pendingSegments: 0,
  timeline: 'ok',
  checkedAt: '2026-10-24T09:20:00.000Z',
  ...over,
});
const span = { fromMs: Date.parse('2026-10-20T03:00:00Z'), toMs: Date.parse('2026-10-24T09:15:00Z') };

describe('walLine', () => {
  it('continuous: since when, and no gaps', () => {
    expect(walLine(view())).toEqual({ tone: 'ok', text: 'WAL is continuous since Wed 21 Oct · 02:00:00 UTC · 0 gaps.', tech: 'wal-g wal-verify integrity timeline · 0 gaps' });
  });
  it('an open gap: a restore cannot land inside it, nor after it yet', () => {
    const l = walLine(view({ status: 'gaps', gaps: [GAP], pendingSegments: 1 }))!;
    expect(l.tone).toBe('bad');
    expect(l.text).toBe(
      "WAL has a gap from Wed 21 Oct · 13:10:00 UTC to Wed 21 Oct · 13:25:00 UTC: a restore can't land inside it. Nothing after it can be restored until a new base copy is taken.",
    );
    expect(l.tech).toBe('wal-g wal-verify integrity timeline · 1 gap · 1 newest segment still uploading');
  });
  it('a bridged gap is a warning, naming when times restore again', () => {
    const l = walLine(view({ status: 'gaps', gaps: [{ ...GAP, reachableAgainAt: '2026-10-22T03:00:00.000Z' }] }))!;
    expect(l.tone).toBe('warn');
    expect(l.text).toContain('Times from Thu 22 Oct · 03:00:00 UTC restore again from the base copy taken after it.');
  });
  it('no read (none, unsupported, still loading) says nothing', () => {
    expect(walLine(undefined)).toBeNull();
    expect(walLine(view({ source: 'unsupported', status: null }))).toBeNull();
  });
});

describe('walBlocked', () => {
  it('blocks from the gap to the next base copy, or to the end of the window', () => {
    expect(walBlocked(view({ gaps: [GAP] }), span)).toEqual([{ fromMs: Date.parse(GAP.from), toMs: span.toMs }]);
    const bridged = walBlocked(view({ gaps: [{ ...GAP, reachableAgainAt: '2026-10-22T03:00:00.000Z' }] }), span);
    expect(bridged).toEqual([{ fromMs: Date.parse(GAP.from), toMs: Date.parse('2026-10-22T03:00:00Z') }]);
    expect(isBlocked(Date.parse('2026-10-21T20:00:00Z'), bridged)).toBe(true);
    expect(isBlocked(Date.parse('2026-10-21T13:10:00Z'), bridged)).toBe(false);
    expect(isBlocked(Date.parse('2026-10-23T00:00:00Z'), bridged)).toBe(false);
  });
});
