import { describe, expect, test } from 'bun:test';
import { clampPit, formatPit, nudgePit, parsePit, pickPitrWindow, pitAxis, pitInput, pitSegments, pitSpan, segmentOf, spanDays } from './pitr-scrub';

const from = '2026-09-17T00:00:00.400Z';
const to = '2026-09-24T03:00:41.900Z';
const span = pitSpan({ from, to })!;

describe('pitSpan', () => {
  test('rounds inward to whole seconds', () => {
    expect(span.fromMs).toBe(Date.parse('2026-09-17T00:00:01Z'));
    expect(span.toMs).toBe(Date.parse('2026-09-24T03:00:41Z'));
  });
  test('no window, a bad one or an empty one is null', () => {
    expect(pitSpan(null)).toBeNull();
    expect(pitSpan({ from: 'nope', to })).toBeNull();
    expect(pitSpan({ from: to, to: from })).toBeNull();
  });
});

describe('nudges and clamping', () => {
  test('±10 s moves by whole steps', () => {
    const t = Date.parse('2026-09-21T03:02:07Z');
    expect(nudgePit(t, 1, span) - t).toBe(10_000);
    expect(t - nudgePit(t, -3, span)).toBe(30_000);
  });
  test('never leaves the window', () => {
    expect(nudgePit(span.toMs, 1, span)).toBe(span.toMs);
    expect(nudgePit(span.fromMs, -1, span)).toBe(span.fromMs);
    expect(clampPit(span.fromMs - 86_400_000, span)).toBe(span.fromMs);
  });
});

describe('segments', () => {
  test('28 blocks cover the window end to end', () => {
    const segs = pitSegments(span);
    expect(segs).toHaveLength(28);
    expect(segs[0]!.startMs).toBe(span.fromMs);
    expect(segs[27]!.endMs).toBe(span.toMs);
    for (const s of segs) expect(s.midMs % 1000).toBe(0);
  });
  test('a time maps back to its block', () => {
    const segs = pitSegments(span);
    expect(segmentOf(segs[5]!.midMs, span)).toBe(5);
    expect(segmentOf(span.toMs, span)).toBe(27);
    expect(segmentOf(span.fromMs - 1, span)).toBe(0);
  });
});

describe('labels', () => {
  test('days covered and the axis', () => {
    expect(spanDays(span)).toBe(7);
    const axis = pitAxis(span);
    expect(axis.map((a) => a.label)).toEqual(['Thu 17', 'Fri 18', 'Sun 20', 'Tue 22', 'latest']);
    expect(axis[0]!.frac).toBe(0);
    expect(axis[4]!.frac).toBe(1);
  });
  test('the stepper and the text box forms', () => {
    const t = Date.parse('2026-09-21T03:02:07Z');
    expect(formatPit(t)).toBe('Mon 21 Sep · 03:02:07');
    expect(pitInput(t)).toBe('2026-09-21 03:02:07');
  });
});

describe('parsePit', () => {
  test('reads the box form, ISO and minutes-only as UTC', () => {
    const t = Date.parse('2026-09-21T03:02:07Z');
    expect(parsePit('2026-09-21 03:02:07')).toBe(t);
    expect(parsePit(' 2026-09-21T03:02:07Z ')).toBe(t);
    expect(parsePit('2026-09-21T03:02:07.000Z')).toBe(t);
    expect(parsePit('2026-09-21 03:02')).toBe(t - 7_000);
  });
  test('rejects what isn’t a real time', () => {
    expect(parsePit('yesterday')).toBeNull();
    expect(parsePit('2026-02-31 03:00:00')).toBeNull();
    expect(parsePit('2026-09-21 25:00:00')).toBeNull();
    expect(parsePit('2026-09-21 03:02:07+02:00')).toBeNull();
  });
});

describe('pickPitrWindow', () => {
  const real = { from: '2026-09-20T03:00:00Z', to: '2026-09-24T03:00:00Z' };
  const guess = { from: '2026-09-10T00:00:00Z', to: '2026-09-24T00:00:00Z' };
  test("the agent's read of the WAL repo wins over the schedule's estimate", () => {
    expect(pickPitrWindow({ source: 'agent', window: real }, { pitrWindow: guess, pitrWindowSource: 'estimate' })).toEqual({ window: real, source: 'agent' });
  });
  test('a read with no base backups is no window, whatever the estimate says', () => {
    expect(pickPitrWindow({ source: 'agent', window: null }, { pitrWindow: guess })).toEqual({ window: null, source: 'agent' });
  });
  test("an older agent (or no read yet) keeps the overview's window and its source", () => {
    expect(pickPitrWindow({ source: 'unsupported', window: null }, { pitrWindow: guess, pitrWindowSource: 'estimate' })).toEqual({ window: guess, source: 'estimate' });
    expect(pickPitrWindow(undefined, { pitrWindow: real, pitrWindowSource: 'agent' })).toEqual({ window: real, source: 'agent' });
    expect(pickPitrWindow(undefined, { pitrWindow: guess })).toEqual({ window: guess, source: 'estimate' });
    expect(pickPitrWindow(null, null)).toEqual({ window: null, source: null });
  });
});
