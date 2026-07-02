import { describe, expect, it } from 'bun:test';
import {
  aggRowsToBuckets,
  aggregateUptimeDays,
  bucketsToDays,
  dayKeyUtc,
  healthToPublic,
  parseComponents,
  samplesToBuckets,
  statusFromInvServices,
  windowUptimePct,
  worstStatus,
  type UptimeSampleLite,
} from './statusPages.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed "now" mid-day UTC so day boundaries are unambiguous. */
const NOW = new Date('2026-07-02T12:00:00.000Z');

const at = (daysAgo: number, hour = 6): Date =>
  new Date(NOW.getTime() - daysAgo * DAY_MS + (hour - 12) * 60 * 60 * 1000);

const sample = (daysAgo: number, status: UptimeSampleLite['status'], hour = 6): UptimeSampleLite => ({
  at: at(daysAgo, hour),
  status,
});

describe('aggregateUptimeDays — samples → daily pct', () => {
  it('produces one entry per day, oldest → newest, ending today (UTC)', () => {
    const days = aggregateUptimeDays([], 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[6]!.day).toBe('2026-07-02');
    expect(days[0]!.day).toBe('2026-06-26');
    expect(days.every((d) => d.pct === null)).toBe(true);
  });

  it('computes pct per day: up=1, degraded=0.5, down=0', () => {
    const samples: UptimeSampleLite[] = [
      // yesterday: 3 up, 1 down → 75%
      sample(1, 'up', 1),
      sample(1, 'up', 8),
      sample(1, 'up', 15),
      sample(1, 'down', 20),
      // two days ago: 1 up, 1 degraded → 75%... no: (1 + 0.5) / 2 = 75%
      sample(2, 'up'),
      sample(2, 'degraded'),
      // today: all up → 100%
      sample(0, 'up', 9),
      sample(0, 'up', 11),
    ];
    const days = aggregateUptimeDays(samples, 4, NOW);
    expect(days.map((d) => d.day)).toEqual(['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02']);
    expect(days[0]!.pct).toBeNull(); // no samples 3 days ago
    expect(days[1]!.pct).toBe(75);
    expect(days[2]!.pct).toBe(75);
    expect(days[3]!.pct).toBe(100);
  });

  it('a fully-down day reads 0 (not null)', () => {
    const days = aggregateUptimeDays([sample(1, 'down'), sample(1, 'down')], 2, NOW);
    expect(days[0]!.pct).toBe(0);
  });

  it('ignores samples older than the window', () => {
    const days = aggregateUptimeDays([sample(10, 'down')], 3, NOW);
    expect(days.every((d) => d.pct === null)).toBe(true);
  });

  it('rounds to 2 decimals', () => {
    // 2 up + 1 down over 3 samples = 66.666…%
    const days = aggregateUptimeDays(
      [sample(0, 'up', 1), sample(0, 'up', 2), sample(0, 'down', 3)],
      1,
      NOW,
    );
    expect(days[0]!.pct).toBe(66.67);
  });
});

describe('samplesToBuckets / bucketsToDays', () => {
  it('buckets by UTC day key', () => {
    const buckets = samplesToBuckets([
      { at: new Date('2026-07-01T23:59:59.000Z'), status: 'up' },
      { at: new Date('2026-07-02T00:00:01.000Z'), status: 'down' },
    ]);
    expect(buckets.get('2026-07-01')).toEqual({ total: 1, score: 1 });
    expect(buckets.get('2026-07-02')).toEqual({ total: 1, score: 0 });
  });

  it('bucketsToDays tolerates an empty bucket map', () => {
    expect(bucketsToDays(new Map(), 2, NOW)).toEqual([
      { day: '2026-07-01', pct: null },
      { day: '2026-07-02', pct: null },
    ]);
  });
});

describe('aggRowsToBuckets — SQL daily rows → buckets', () => {
  it('groups by component and scores degraded at half weight', () => {
    const byComponent = aggRowsToBuckets([
      { componentKey: 'api', day: new Date('2026-07-01T00:00:00.000Z'), total: 4, up: 2, degraded: 2 },
      { componentKey: 'web', day: '2026-07-01 00:00:00', total: 1, up: 1, degraded: 0 },
    ]);
    expect(byComponent.get('api')?.get('2026-07-01')).toEqual({ total: 4, score: 3 });
    expect(byComponent.get('web')?.get('2026-07-01')).toEqual({ total: 1, score: 1 });
  });
});

describe('windowUptimePct', () => {
  it('averages only the days that have data', () => {
    expect(
      windowUptimePct([
        { day: 'a', pct: 100 },
        { day: 'b', pct: null },
        { day: 'c', pct: 50 },
      ]),
    ).toBe(75);
  });

  it('null when no day has data', () => {
    expect(windowUptimePct([{ day: 'a', pct: null }])).toBeNull();
  });
});

describe('status folds', () => {
  it('healthToPublic maps the health-summary vocabulary', () => {
    expect(healthToPublic('healthy')).toBe('up');
    expect(healthToPublic('degraded')).toBe('degraded');
    expect(healthToPublic('down')).toBe('down');
    expect(healthToPublic('unknown')).toBe('unknown');
  });

  it('worstStatus: worst known wins; all-unknown stays unknown', () => {
    expect(worstStatus(['up', 'up'])).toBe('up');
    expect(worstStatus(['up', 'degraded'])).toBe('degraded');
    expect(worstStatus(['degraded', 'down', 'up'])).toBe('down');
    expect(worstStatus(['unknown', 'up'])).toBe('up');
    expect(worstStatus(['unknown'])).toBe('unknown');
    expect(worstStatus([])).toBe('unknown');
  });
});

describe('statusFromInvServices — managed cluster fold', () => {
  const member = (desired: number, running: number, labels: Record<string, string> = {}) => ({
    replicas: { desired, running },
    scaleToZero: false,
    labels,
  });

  it('unknown when no active members', () => {
    expect(statusFromInvServices([])).toBe('unknown');
    expect(statusFromInvServices([member(0, 0)])).toBe('unknown');
  });

  it('down when every active member has 0 running', () => {
    expect(statusFromInvServices([member(1, 0), member(2, 0)])).toBe('down');
  });

  it('degraded on a task shortfall', () => {
    expect(statusFromInvServices([member(2, 1), member(1, 1)])).toBe('degraded');
  });

  it('degraded when a replica lag label exceeds target', () => {
    expect(
      statusFromInvServices([member(1, 1, { 'swarmy.db.lag.replica-1': '42s' })]),
    ).toBe('degraded');
  });

  it('up when all tasks run and lag is within target', () => {
    expect(
      statusFromInvServices([member(1, 1, { 'swarmy.db.lag.replica-1': '2s' }), member(2, 2)]),
    ).toBe('up');
  });
});

describe('parseComponents — tolerant componentsJson codec', () => {
  it('accepts a well-formed array (object or JSON string)', () => {
    const components = [
      { key: 'web', label: 'Website', kind: 'service', ref: 'shop_web' },
      { key: 'db', label: 'Database', kind: 'db', ref: 'main' },
    ];
    expect(parseComponents(components)).toEqual(components as never);
    expect(parseComponents(JSON.stringify(components))).toEqual(components as never);
  });

  it('drops malformed entries, duplicate keys and unknown kinds', () => {
    const parsed = parseComponents([
      { key: 'ok', label: 'OK', kind: 'service', ref: 'web' },
      { key: 'ok', label: 'dupe', kind: 'service', ref: 'other' },
      { key: 'bad-kind', label: 'x', kind: 'moon-phase', ref: 'x' },
      { key: '', label: 'no key', kind: 'service', ref: 'x' },
      { key: 'no-ref', label: 'x', kind: 'service', ref: '' },
      'not-an-object',
      null,
    ]);
    expect(parsed).toEqual([{ key: 'ok', label: 'OK', kind: 'service', ref: 'web' }]);
  });

  it('defaults a missing label to the key', () => {
    expect(parseComponents([{ key: 'api', kind: 'service', ref: 'api' }])).toEqual([
      { key: 'api', label: 'api', kind: 'service', ref: 'api' },
    ]);
  });

  it('collapses garbage to []', () => {
    expect(parseComponents(undefined)).toEqual([]);
    expect(parseComponents('not json')).toEqual([]);
    expect(parseComponents({ nope: true })).toEqual([]);
    expect(parseComponents(42)).toEqual([]);
  });
});

describe('dayKeyUtc', () => {
  it('formats the UTC calendar day', () => {
    expect(dayKeyUtc(new Date('2026-07-02T00:00:00.000Z'))).toBe('2026-07-02');
    expect(dayKeyUtc(new Date('2026-07-02T23:59:59.999Z'))).toBe('2026-07-02');
  });
});
