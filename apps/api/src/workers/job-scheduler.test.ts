import { describe, expect, it } from 'bun:test';
import { cronNext, parseCron, retryBackoffMs, selectDueJobs, type DueCandidate } from './job-scheduler';

/**
 * Worker-side due selection (the mirror of @swarmy/trpc jobs.service /
 * schedule.ts — see the canonical tests there for the full cron matrix; this
 * file pins the mirror's behaviour so drift is caught).
 */

const at = (iso: string): Date => new Date(iso);

const job = (over: Partial<DueCandidate>): DueCandidate => ({
  id: 'j1',
  schedule: '0 2 * * *',
  enabled: true,
  lastRunAt: null,
  createdAt: at('2026-06-01T00:00:00Z'),
  ...over,
});

describe('cron mirror', () => {
  it('matches the canonical evaluator on DOW/range/step shapes', () => {
    // 2026-07-02 is a Thursday.
    expect(cronNext(parseCron('0 9 * * 1'), at('2026-07-02T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-06T09:00:00.000Z',
    );
    expect(cronNext(parseCron('*/15 * * * *'), at('2026-07-02T10:07:00Z'))?.toISOString()).toBe(
      '2026-07-02T10:15:00.000Z',
    );
    expect(cronNext(parseCron('0 9-17/4 * * *'), at('2026-07-02T09:30:00Z'))?.toISOString()).toBe(
      '2026-07-02T13:00:00.000Z',
    );
    // dom/dow OR rule + 7 == Sunday.
    expect(cronNext(parseCron('0 0 15 * 1'), at('2026-07-02T01:00:00Z'))?.toISOString()).toBe(
      '2026-07-06T00:00:00.000Z',
    );
    expect(cronNext(parseCron('0 0 * * 7'), at('2026-07-02T00:00:00Z'))?.toISOString()).toBe(
      '2026-07-05T00:00:00.000Z',
    );
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 2 * *')).toThrow();
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
  });
});

describe('selectDueJobs', () => {
  const now = at('2026-07-02T02:00:30Z');

  it('fires jobs whose next slot after lastRunAt has passed', () => {
    expect(selectDueJobs([job({ lastRunAt: at('2026-07-01T02:00:00Z') })], now)).toEqual(['j1']);
  });

  it('skips jobs already fired for the current slot', () => {
    expect(selectDueJobs([job({ lastRunAt: at('2026-07-02T02:00:30Z') })], now)).toEqual([]);
  });

  it('anchors never-run jobs to createdAt — creation is not a fire', () => {
    expect(selectDueJobs([job({ createdAt: at('2026-07-02T01:00:00Z') })], now)).toEqual(['j1']);
    expect(selectDueJobs([job({ createdAt: at('2026-07-02T02:00:10Z') })], now)).toEqual([]);
  });

  it('skips disabled jobs and unparseable schedules', () => {
    expect(selectDueJobs([job({ enabled: false }), job({ id: 'j2', schedule: 'bogus' })], now)).toEqual([]);
  });

  it('collapses a week of missed slots into one fire', () => {
    const stale = job({ lastRunAt: at('2026-06-25T02:00:00Z') });
    expect(selectDueJobs([stale], now)).toEqual(['j1']);
    expect(selectDueJobs([{ ...stale, lastRunAt: now }], now)).toEqual([]);
  });
});

describe('retryBackoffMs mirror', () => {
  it('doubles from 5s capped at 60s', () => {
    expect([1, 2, 3, 4, 5].map(retryBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });
});
