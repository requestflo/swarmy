import { describe, expect, it } from 'bun:test';
import {
  backupMissedConditions,
  derivedNextBackupRun,
  conditionKey,
  crashLoopConditions,
  dbLagConditions,
  diskConditions,
  errorRateConditions,
  gateConditions,
  leaderChanges,
  parseLagSeconds,
  queueDepthConditions,
  ruleSettings,
  serviceDownConditions,
  type Condition,
  type RuleLike,
} from './alert-evaluator';

const cond = (over: Partial<Condition> = {}): Condition => ({
  signal: 'node-offline',
  resource: 'node:w1',
  severity: 'critical',
  message: 'Server w1 is offline',
  ...over,
});

describe('gateConditions (for-duration state machine)', () => {
  it('fires immediately when forSeconds is 0', () => {
    const pending = new Map<string, number>();
    const ready = gateConditions(pending, [cond()], () => 0, 1_000_000);
    expect(ready).toHaveLength(1);
  });

  it('holds a gated condition until it has been true long enough', () => {
    const pending = new Map<string, number>();
    const forSec = (): number => 60;
    expect(gateConditions(pending, [cond()], forSec, 0)).toHaveLength(0);
    expect(gateConditions(pending, [cond()], forSec, 30_000)).toHaveLength(0);
    expect(gateConditions(pending, [cond()], forSec, 60_000)).toHaveLength(1);
    // Stays fired while the condition persists.
    expect(gateConditions(pending, [cond()], forSec, 90_000)).toHaveLength(1);
  });

  it('resets the clock when the condition clears between ticks', () => {
    const pending = new Map<string, number>();
    const forSec = (): number => 60;
    gateConditions(pending, [cond()], forSec, 0);
    gateConditions(pending, [], forSec, 30_000); // condition cleared
    expect(gateConditions(pending, [cond()], forSec, 60_000)).toHaveLength(0); // clock restarted
    expect(gateConditions(pending, [cond()], forSec, 120_000)).toHaveLength(1);
  });

  it('tracks distinct resources independently', () => {
    const pending = new Map<string, number>();
    const forSec = (): number => 60;
    gateConditions(pending, [cond()], forSec, 0);
    const ready = gateConditions(
      pending,
      [cond(), cond({ resource: 'node:w2' })],
      forSec,
      60_000,
    );
    expect(ready.map((c) => c.resource)).toEqual(['node:w1']);
  });
});

describe('condition builders', () => {
  it('service-down: fires only on shortfall, critical at 0 running', () => {
    const out = serviceDownConditions([
      { name: 'web', desired: 3, running: 3 },
      { name: 'api', desired: 2, running: 1 },
      { name: 'worker', desired: 1, running: 0 },
      { name: 'parked', desired: 0, running: 0 },
    ]);
    expect(out.map((c) => [c.resource, c.severity])).toEqual([
      ['service:api', 'warning'],
      ['service:worker', 'critical'],
    ]);
  });

  it('disk: percent threshold with null-safe stats', () => {
    const gb = 1024 ** 3;
    const out = diskConditions(
      [
        { name: 'w1', usedBytes: 85 * gb, totalBytes: 100 * gb },
        { name: 'w2', usedBytes: 50 * gb, totalBytes: 100 * gb },
        { name: 'w3', usedBytes: null, totalBytes: null },
        { name: 'w4', usedBytes: 95 * gb, totalBytes: 100 * gb },
      ],
      80,
    );
    expect(out.map((c) => [c.resource, c.severity])).toEqual([
      ['node:w1', 'warning'],
      ['node:w4', 'critical'],
    ]);
  });

  it('queue depth: strictly above the threshold', () => {
    const out = queueDepthConditions(
      [
        { worker: 'w', queue: 'emails', wait: 1000 },
        { worker: 'w', queue: 'resize', wait: 1001 },
      ],
      1000,
    );
    expect(out.map((c) => c.resource)).toEqual(['queue:w/resize']);
  });

  it('error rate: respects the minimum sample size', () => {
    const out = errorRateConditions(
      [
        { service: 'quiet', calls: 5, errors: 5 }, // 100% but too few samples
        { service: 'noisy', calls: 200, errors: 20 }, // 10%
        { service: 'fine', calls: 200, errors: 4 }, // 2%
      ],
      5,
      20,
    );
    expect(out.map((c) => c.resource)).toEqual(['service:noisy']);
  });

  it('db lag: one condition per cluster, worst member wins', () => {
    const out = dbLagConditions(
      [
        { cluster: 'shop/main', member: 'replica-1', lagSeconds: 45 },
        { cluster: 'shop/main', member: 'replica-2', lagSeconds: 90 },
        { cluster: 'shop/other', member: 'replica-1', lagSeconds: 5 },
      ],
      30,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.resource).toBe('db:shop/main');
    expect(out[0]?.message).toContain('replica-2');
  });
});

describe('parseLagSeconds (health-summary mirror)', () => {
  it('parses units and bare numbers', () => {
    expect(parseLagSeconds('12s')).toBe(12);
    expect(parseLagSeconds('850ms')).toBe(0.85);
    expect(parseLagSeconds('45')).toBe(45);
    expect(parseLagSeconds('12000')).toBe(12); // big bare value reads as ms
    expect(parseLagSeconds('nope')).toBeNull();
    expect(parseLagSeconds('')).toBeNull();
  });
});

describe('leaderChanges (db-failover edge)', () => {
  it('detects flips only for clusters known on both ticks', () => {
    const prev = new Map([
      ['shop/main', 'shop_main-db'],
      ['shop/old', 'shop_old-db'],
    ]);
    const curr = new Map([
      ['shop/main', 'shop_main-db-replica'],
      ['shop/new', 'shop_new-db'],
    ]);
    expect(leaderChanges(prev, curr)).toEqual([
      { cluster: 'shop/main', from: 'shop_main-db', to: 'shop_main-db-replica' },
    ]);
    expect(leaderChanges(curr, curr)).toEqual([]);
  });
});

describe('ruleSettings', () => {
  const rule = (over: Partial<RuleLike>): RuleLike => ({
    signal: 'disk-usage',
    threshold: null,
    forSeconds: 0,
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  it('falls back to the catalog defaults when the org has no rule', () => {
    expect(ruleSettings([], 'disk-usage')).toEqual({ threshold: 85, forSeconds: 0 });
    expect(ruleSettings([], 'node-offline')).toEqual({ threshold: 0, forSeconds: 300 });
  });

  it('prefers a custom rule over the seeded default', () => {
    const rules = [
      rule({ threshold: 70, isDefault: true }),
      rule({ threshold: 95, isDefault: false, createdAt: new Date('2026-02-01T00:00:00Z') }),
    ];
    expect(ruleSettings(rules, 'disk-usage').threshold).toBe(95);
  });
});

describe('conditionKey', () => {
  it('is the dedupe axis signal|resource', () => {
    expect(conditionKey(cond())).toBe('node-offline|node:w1');
  });
});

describe('default-alert signals (launch-blocker #6)', () => {
  it('crash-loop: fires at/above the failure threshold, never for unknown task health', () => {
    const out = crashLoopConditions(
      [
        { name: 'web', recentFailures: 3, lastError: 'exit 137 (OOM)' },
        { name: 'api', recentFailures: 2 },
        { name: 'legacy', recentFailures: null },
      ],
      3,
    );
    expect(out.map((c) => [c.signal, c.resource, c.severity])).toEqual([['crash-loop', 'service:web', 'critical']]);
    expect(out[0]!.message).toContain('exit 137 (OOM)');
    // A threshold of 0 still needs at least one failure.
    expect(crashLoopConditions([{ name: 'ok', recentFailures: 0 }], 0)).toEqual([]);
  });

  it('backup missed: only unpaused, non-opted-out schedules past the grace', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    const out = backupMissedConditions(
      [
        { volume: 'late', paused: false, optedOutAt: null, nextRunAt: at('2026-09-24T09:00:00Z') },
        { volume: 'grace', paused: false, optedOutAt: null, nextRunAt: at('2026-09-24T11:30:00Z') },
        { volume: 'paused', paused: true, optedOutAt: null, nextRunAt: at('2026-09-20T00:00:00Z') },
        { volume: 'gone', paused: false, optedOutAt: at('2026-09-01T00:00:00Z'), nextRunAt: at('2026-09-20T00:00:00Z') },
        { volume: 'never', paused: false, optedOutAt: null, nextRunAt: null },
      ],
      now,
    );
    expect(out.map((c) => [c.signal, c.resource])).toEqual([['backup-failed', 'backup:late']]);
    expect(out[0]!.message).toContain('180 min late');
  });

  it('derives a backup schedule next slot from its last run (no stored nextRunAt)', () => {
    const at = (iso: string) => new Date(iso);
    const s = { every: 1, unit: 'days', createdAt: at('2026-09-20T10:00:00Z'), anchorAt: at('2026-09-20T03:00:00Z') };
    expect(derivedNextBackupRun(s, null)?.toISOString()).toBe('2026-09-21T03:00:00.000Z');
    expect(derivedNextBackupRun(s, at('2026-09-23T03:00:04Z'))?.toISOString()).toBe('2026-09-24T03:00:00.000Z');
    expect(derivedNextBackupRun({ ...s, anchorAt: null }, null)?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
    expect(derivedNextBackupRun({ ...s, unit: 'fortnights' }, null)).toBeNull();
  });
});
