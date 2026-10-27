import { describe, expect, it } from 'bun:test';
import {
  SWITCHOVER_DRAIN_TIMEOUT_MS,
  SWITCHOVER_PROMOTE_TIMEOUT_MS,
  SWITCHOVER_REJOIN_TIMEOUT_MS,
  drainDecision,
  encodeSwitchoverRequest,
  parseSwitchoverRequest,
  plannedPromotion,
  promoteDecision,
  rejoinDecision,
} from './manageddb-switchover-run';
import { DB_SWITCHOVER_LABEL, switchoverRequested, switchoverStale } from './volume-move';

describe('drainDecision — catch up to the paused writer, bounded', () => {
  it('ready only at 0 bytes behind the final flushed position', () => {
    expect(drainDecision({ finalLsn: '0/3000000', replayLsn: '0/3000000', elapsedMs: 0 })).toEqual({ kind: 'ready' });
    expect(drainDecision({ finalLsn: '0/3000000', replayLsn: '0/3000010', elapsedMs: 0 })).toEqual({ kind: 'ready' });
    expect(drainDecision({ finalLsn: '0/3000000', replayLsn: '0/2FFFF00', elapsedMs: 1000 })).toEqual({ kind: 'wait', behindBytes: 256 });
  });

  it('an unread replay position waits, then aborts with an unknown gap', () => {
    expect(drainDecision({ finalLsn: '0/3000000', replayLsn: null, elapsedMs: 0 })).toEqual({ kind: 'wait', behindBytes: null });
    const late = drainDecision({ finalLsn: '0/3000000', replayLsn: null, elapsedMs: SWITCHOVER_DRAIN_TIMEOUT_MS + 1 });
    expect(late).toMatchObject({ kind: 'abort' });
    if (late.kind === 'abort') expect(late.reason).toContain('an unknown amount behind');
  });

  it('aborts on timeout with the bytes still missing', () => {
    const d = drainDecision({ finalLsn: '0/3000000', replayLsn: '0/2FFFF00', elapsedMs: SWITCHOVER_DRAIN_TIMEOUT_MS + 1 });
    expect(d).toEqual({ kind: 'abort', reason: 'the copy was still 256 bytes behind the paused main copy, so nothing was switched and writes resumed' });
  });
});

describe('promoteDecision — the reconcile promotes, holds, or runs out of time', () => {
  it('promoted once the target carries the primary role', () => {
    expect(promoteDecision({ targetRole: 'primary', held: true, elapsedMs: 0 })).toEqual({ kind: 'promoted' });
    expect(promoteDecision({ targetRole: 'replica', held: false, elapsedMs: 1000 })).toEqual({ kind: 'wait' });
  });

  it('a held decision aborts at once; a slow one aborts at the deadline', () => {
    expect(promoteDecision({ targetRole: 'replica', held: true, elapsedMs: 0 })).toMatchObject({ kind: 'abort' });
    expect(promoteDecision({ targetRole: undefined, held: false, elapsedMs: SWITCHOVER_PROMOTE_TIMEOUT_MS + 1 })).toMatchObject({ kind: 'abort' });
  });
});

describe('rejoinDecision — slow is a warning, never an undo', () => {
  it('joined, wait, late', () => {
    expect(rejoinDecision({ running: 1, elapsedMs: SWITCHOVER_REJOIN_TIMEOUT_MS * 2 })).toBe('joined');
    expect(rejoinDecision({ running: 0, elapsedMs: 0 })).toBe('wait');
    expect(rejoinDecision({ running: 0, elapsedMs: SWITCHOVER_REJOIN_TIMEOUT_MS + 1 })).toBe('late');
  });
});

describe('the request label', () => {
  const at = '2026-10-26T10:00:00.000Z';
  const NOW = Date.parse(at);

  it('round-trips, and the bare-ISO older form still parses', () => {
    const raw = encodeSwitchoverRequest({ at, target: 'shop_db-replica', finalLsn: '0/3000000' });
    expect(parseSwitchoverRequest(raw)).toEqual({ at, target: 'shop_db-replica', finalLsn: '0/3000000' });
    expect(parseSwitchoverRequest(at)).toEqual({ at });
    expect(parseSwitchoverRequest('{"target":"x"}')).toBeNull();
    expect(parseSwitchoverRequest('{nope')).toBeNull();
    expect(parseSwitchoverRequest(undefined)).toBeNull();
  });

  it('fresh for ten minutes, then stale (a run that died)', () => {
    const labels = { [DB_SWITCHOVER_LABEL]: encodeSwitchoverRequest({ at }) };
    expect(switchoverRequested(labels, NOW + 60_000)).toBe(true);
    expect(switchoverStale(labels, NOW + 60_000)).toBe(false);
    expect(switchoverStale(labels, NOW + 11 * 60_000)).toBe(true);
    expect(switchoverStale({ [DB_SWITCHOVER_LABEL]: 'garbage' }, NOW)).toBe(true);
    expect(switchoverStale({}, NOW)).toBe(false);
  });
});

describe('plannedPromotion — narrows the candidates, only ever raises the bar', () => {
  const candidates = [{ service: 'a' }, { service: 'b' }];
  const watermark = { lsn: '0/2000000', sampledAt: 5 };

  it('no request: untouched', () => {
    expect(plannedPromotion({ candidates, watermark }, null)).toEqual({ candidates, watermark });
  });

  it('the target alone is a candidate (gone ⇒ nobody, so decideFailover waits)', () => {
    expect(plannedPromotion({ candidates, watermark }, { at: 'x', target: 'b' }).candidates).toEqual([{ service: 'b' }]);
    expect(plannedPromotion({ candidates, watermark }, { at: 'x', target: 'c' }).candidates).toEqual([]);
  });

  it('a request naming a copy narrows to that one copy of the service', () => {
    const copies = [{ service: 'b', copy: 'n1' }, { service: 'b', copy: 'n2' }, { service: 'a', copy: 'n2' }];
    expect(plannedPromotion({ candidates: copies, watermark }, { at: 'x', target: 'b', copy: 'n2' }).candidates).toEqual([{ service: 'b', copy: 'n2' }]);
    expect(parseSwitchoverRequest(encodeSwitchoverRequest({ at: '2026-10-27T00:00:00Z', target: 'b', copy: 'n2' }))).toEqual({ at: '2026-10-27T00:00:00Z', target: 'b', copy: 'n2' });
  });

  it('a later final position raises the watermark; an earlier or unreadable one does not', () => {
    expect(plannedPromotion({ candidates, watermark }, { at: 'x', finalLsn: '0/3000000' }).watermark).toEqual({ lsn: '0/3000000', sampledAt: 5 });
    expect(plannedPromotion({ candidates, watermark }, { at: 'x', finalLsn: '0/1000000' }).watermark).toEqual(watermark);
    expect(plannedPromotion({ candidates, watermark }, { at: 'x', finalLsn: 'junk' }).watermark).toEqual(watermark);
  });

  it('never invents a watermark the reconcile did not sample (unknown ⇒ hold)', () => {
    expect(plannedPromotion({ candidates, watermark: null }, { at: 'x', finalLsn: '0/3000000' }).watermark).toBeNull();
  });
});
