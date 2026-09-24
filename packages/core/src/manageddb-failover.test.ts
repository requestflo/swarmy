import { describe, expect, it } from 'bun:test';
import {
  FAILOVER_WATERMARK_MAX_GAP_MS,
  behindWatermarkBytes,
  confirmationCovers,
  decideFailover,
  encodeFailoverConfirmation,
  encodePendingFailover,
  failoverPolicy,
  parseFailoverConfirmation,
  parsePendingFailover,
  pendingFailoverChanged,
  watermarkIsFresh,
  type DecideFailoverInput,
  type FailoverCandidate,
} from './manageddb-failover';

const T = 1_750_000_000_000;
const cand = (service: string, replayLsn: string | null, lagSeconds: number | null = 0, running = 1): FailoverCandidate => ({
  service,
  running,
  replayLsn,
  lagSeconds,
});
const input = (over: Partial<DecideFailoverInput> = {}): DecideFailoverInput => ({
  topology: 'geo',
  candidates: [cand('app_db-replica-eu', '0/3000100')],
  watermark: { lsn: '0/3000100', sampledAt: T },
  lastHealthyAt: T,
  confirmation: null,
  ...over,
});

describe('failover safety — no silent data loss (owner decision 2026-09-24)', () => {
  it('per topology: single + active-active never promote; the three async topologies are gated', () => {
    expect(failoverPolicy('single')).toBe('never');
    expect(failoverPolicy('active-active')).toBe('never');
    expect(failoverPolicy('primary-replica')).toBe('gated');
    expect(failoverPolicy('failover')).toBe('gated');
    expect(failoverPolicy('geo')).toBe('gated');
    expect(decideFailover(input({ topology: 'single' })).kind).toBe('never');
    expect(decideFailover(input({ topology: 'active-active' })).kind).toBe('never');
  });

  it('auto-promotes ONLY a replica whose replay LSN reached the last flushed LSN', () => {
    for (const topology of ['primary-replica', 'failover', 'geo'] as const) {
      expect(decideFailover(input({ topology }))).toEqual({
        kind: 'promote',
        target: 'app_db-replica-eu',
        behindBytes: 0,
        behindSeconds: 0,
        confirmed: false,
      });
    }
  });

  it('a replica past the watermark (it received more after the sample) is caught up', () => {
    const d = decideFailover(input({ candidates: [cand('r', '0/3000200')] }));
    expect(d.kind).toBe('promote');
  });

  it('a replica 1 byte behind is NOT auto-promoted — it asks for confirmation with the window', () => {
    const d = decideFailover(input({ candidates: [cand('app_db-replica-us', '0/30000FF', 4.2)] }));
    expect(d).toMatchObject({ kind: 'confirm', target: 'app_db-replica-us', behindBytes: 1, behindSeconds: 4.2 });
  });

  it('seconds-lag of 0 is not proof — only the LSN is', () => {
    const d = decideFailover(input({ candidates: [cand('r', '0/2000000', 0)] }));
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') expect(d.behindBytes).toBe(0x1000100);
  });

  it('unknown watermark (controller restarted) ⇒ confirmation, window unknown', () => {
    const d = decideFailover(input({ watermark: null, lastHealthyAt: null }));
    expect(d).toMatchObject({ kind: 'confirm', behindBytes: null });
    if (d.kind === 'confirm') expect(d.reason).toContain('unknown');
  });

  it('a stale watermark (the probe missed the last healthy tick) is not proof', () => {
    const d = decideFailover(
      input({ watermark: { lsn: '0/3000100', sampledAt: T - FAILOVER_WATERMARK_MAX_GAP_MS - 1 } }),
    );
    expect(d).toMatchObject({ kind: 'confirm', behindBytes: null });
    if (d.kind === 'confirm') expect(d.reason).toContain('stale');
  });

  it('an unmeasured replica (no replay LSN) is not proof', () => {
    expect(decideFailover(input({ candidates: [cand('r', null)] }))).toMatchObject({
      kind: 'confirm',
      behindBytes: null,
    });
  });

  it('prefers the caught-up replica over a lower seconds-lag one that is behind', () => {
    const d = decideFailover(
      input({ candidates: [cand('a-behind', '0/3000000', 0), cand('b-caught-up', '0/3000100', 9)] }),
    );
    expect(d).toMatchObject({ kind: 'promote', target: 'b-caught-up', confirmed: false });
  });

  it('stopped replicas are never candidates; none running ⇒ wait', () => {
    expect(decideFailover(input({ candidates: [cand('r', '0/3000100', 0, 0)] })).kind).toBe('wait');
  });

  it('an admin confirmation covering the window promotes (confirmed)', () => {
    const d = decideFailover(
      input({
        candidates: [cand('r', '0/3000000', 3)],
        confirmation: { target: 'r', acceptBehindBytes: 256 },
      }),
    );
    expect(d).toEqual({ kind: 'promote', target: 'r', behindBytes: 256, behindSeconds: 3, confirmed: true });
  });

  it('a confirmation does NOT apply once the window grows past what was accepted', () => {
    const d = decideFailover(
      input({
        candidates: [cand('r', '0/3000000')],
        confirmation: { target: 'r', acceptBehindBytes: 255 },
      }),
    );
    expect(d.kind).toBe('confirm');
  });

  it('a numeric confirmation does not cover an unknown window; "unknown" covers any', () => {
    const unknown = input({ watermark: null, lastHealthyAt: null, candidates: [cand('r', '0/1')] });
    expect(decideFailover({ ...unknown, confirmation: { target: 'r', acceptBehindBytes: 1_000_000 } }).kind).toBe('confirm');
    expect(decideFailover({ ...unknown, confirmation: { target: 'r', acceptBehindBytes: 'unknown' } })).toMatchObject({
      kind: 'promote',
      confirmed: true,
      behindBytes: null,
    });
  });

  it('the admin may pick a replica other than the best one; a confirmation for a gone replica is ignored', () => {
    const cands = [cand('best', '0/30000F0'), cand('other', '0/3000000')];
    expect(
      decideFailover(input({ candidates: cands, confirmation: { target: 'other', acceptBehindBytes: 'unknown' } })),
    ).toMatchObject({ kind: 'promote', target: 'other', confirmed: true });
    expect(
      decideFailover(input({ candidates: cands, confirmation: { target: 'gone', acceptBehindBytes: 'unknown' } })),
    ).toMatchObject({ kind: 'confirm', target: 'best' });
  });
});

describe('failover helpers', () => {
  it('behindWatermarkBytes clamps at 0 and rejects garbage', () => {
    expect(behindWatermarkBytes('1/0', '0/FFFFFFFF')).toBe(1);
    expect(behindWatermarkBytes('0/10', '0/20')).toBe(0);
    expect(behindWatermarkBytes('nope', '0/1')).toBeNull();
  });

  it('watermarkIsFresh needs both a sample and a healthy observation within the gap', () => {
    expect(watermarkIsFresh(null, T)).toBe(false);
    expect(watermarkIsFresh({ lsn: '0/1', sampledAt: T }, null)).toBe(false);
    expect(watermarkIsFresh({ lsn: '0/1', sampledAt: T - FAILOVER_WATERMARK_MAX_GAP_MS }, T)).toBe(true);
  });

  it('confirmationCovers', () => {
    expect(confirmationCovers({ target: 'r', acceptBehindBytes: 10 }, 10)).toBe(true);
    expect(confirmationCovers({ target: 'r', acceptBehindBytes: 10 }, 11)).toBe(false);
    expect(confirmationCovers({ target: 'r', acceptBehindBytes: 10 }, null)).toBe(false);
    expect(confirmationCovers({ target: 'r', acceptBehindBytes: 'unknown' }, null)).toBe(true);
  });
});

describe('pending / confirm label codecs', () => {
  it('round-trips a pending failover', () => {
    const p = { target: 'r', behindBytes: 42, behindSeconds: 1.5, reason: 'x', since: '2026-09-24T00:00:00.000Z' };
    expect(parsePendingFailover(encodePendingFailover(p))).toEqual(p);
    expect(parsePendingFailover(undefined)).toBeNull();
    expect(parsePendingFailover('{bad')).toBeNull();
    expect(parsePendingFailover('{"behindBytes":1}')).toBeNull();
  });

  it('only a target/window/reason change relabels (seconds drift does not)', () => {
    const p = { target: 'r', behindBytes: 42, behindSeconds: 1.5, reason: 'x', since: 's' };
    expect(pendingFailoverChanged(null, p)).toBe(true);
    expect(pendingFailoverChanged(p, { ...p, behindSeconds: 9 })).toBe(false);
    expect(pendingFailoverChanged(p, { ...p, behindBytes: 43 })).toBe(true);
  });

  it('round-trips a confirmation and rejects malformed windows', () => {
    const c = { target: 'r', acceptBehindBytes: 7, by: 'u1', at: 'now' };
    expect(parseFailoverConfirmation(encodeFailoverConfirmation(c))).toEqual(c);
    expect(parseFailoverConfirmation('{"target":"r","acceptBehindBytes":"unknown"}')).toEqual({
      target: 'r',
      acceptBehindBytes: 'unknown',
    });
    expect(parseFailoverConfirmation('{"target":"r","acceptBehindBytes":-1}')).toBeNull();
    expect(parseFailoverConfirmation('{"target":"r"}')).toBeNull();
  });
});
