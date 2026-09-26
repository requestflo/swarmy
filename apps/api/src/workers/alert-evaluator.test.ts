import { describe, expect, it } from 'bun:test';
import {
  LEVEL_SIGNALS,
  backupMissedConditions,
  budgetConditions,
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
  conditionForSeconds,
  fanOut,
  incidentAllowed,
  ruleConditions,
  serviceDownConditions,
  subjectKey,
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

const rule = (over: Partial<RuleLike> & { id: string }): RuleLike => ({
  signal: 'error-rate',
  threshold: null,
  forSeconds: 0,
  enabled: true,
  selector: {},
  mutedUntil: null,
  ...over,
});

// Error rate per Docker service (`<app>_<part>`), as orgErrorRates returns it.
const RATES = [
  { service: 'storefront_checkout', calls: 100, errors: 3 }, // 3%
  { service: 'storefront_web', calls: 100, errors: 6 }, // 6%
  { service: 'blog_web', calls: 100, errors: 7 }, // 7%
];

describe('ruleConditions (several rules per signal, owner decision Q10)', () => {
  it('two rules on one signal, different targets: each fires on its own subjects at its own threshold', () => {
    const rules = [
      rule({ id: 'shop', threshold: 5, selector: { app: 'storefront' } }),
      rule({ id: 'checkout', threshold: 2, selector: { app: 'storefront', service: 'checkout' } }),
    ];
    const out = ruleConditions(rules, 'error-rate', (t) => errorRateConditions(RATES, t));
    expect(out.map((c) => [c.ruleId, c.resource])).toEqual([
      ['shop', 'service:storefront_web'],
      ['checkout', 'service:storefront_checkout'],
    ]);
    // blog is nobody's target, so nothing fires for it.
    expect(out.some((c) => c.resource === 'service:blog_web')).toBe(false);
    // Each rule's condition carries its own threshold in the words.
    expect(out.find((c) => c.ruleId === 'checkout')!.message).toContain('threshold 2%');
  });

  it('an "any" rule and a narrowed rule both fire for the same subject, as separate events', () => {
    const rules = [rule({ id: 'any', threshold: 5 }), rule({ id: 'web', threshold: 5, selector: { app: 'storefront' } })];
    const out = ruleConditions(rules, 'error-rate', (t) => errorRateConditions(RATES, t));
    expect(out.map((c) => `${c.ruleId}:${c.resource}`).sort()).toEqual([
      'any:service:blog_web',
      'any:service:storefront_web',
      'web:service:storefront_web',
    ]);
    expect(new Set(out.map(conditionKey)).size).toBe(3);
  });

  it('builds once per distinct threshold', () => {
    let calls = 0;
    const rules = [rule({ id: 'a', threshold: 5 }), rule({ id: 'b', threshold: 5, selector: { app: 'blog' } }), rule({ id: 'c', threshold: 2 })];
    ruleConditions(rules, 'error-rate', (t) => {
      calls += 1;
      return errorRateConditions(RATES, t);
    });
    expect(calls).toBe(2);
  });

  it('disabled rules fire nothing; a signal with no rule row at all fires ruleless at the catalog default', () => {
    expect(ruleConditions([rule({ id: 'off', enabled: false })], 'error-rate', (t) => errorRateConditions(RATES, t))).toEqual([]);
    const ruleless = ruleConditions([], 'error-rate', (t) => errorRateConditions(RATES, t));
    expect(ruleless.map((c) => [c.ruleId, c.resource])).toEqual([
      [undefined, 'service:storefront_web'],
      [undefined, 'service:blog_web'],
    ]);
  });

  it('server signals narrow to one server (forecast resources included)', () => {
    const rules = [rule({ id: 'lon', signal: 'disk-usage', selector: { server: 'london-2' } })];
    const out = fanOut(rules, [
      cond({ signal: 'disk-usage', resource: 'node:london-2', severity: 'warning' }),
      cond({ signal: 'disk-usage', resource: 'node:london-2:forecast', severity: 'warning' }),
      cond({ signal: 'disk-usage', resource: 'node:wkr-1', severity: 'warning' }),
    ]);
    expect(out.map((c) => [c.ruleId, c.resource])).toEqual([
      ['lon', 'node:london-2'],
      ['lon', 'node:london-2:forecast'],
    ]);
  });

  it('each rule gates on its own for-duration', () => {
    const rules = [rule({ id: 'fast', forSeconds: 0 }), rule({ id: 'slow', forSeconds: 300 })];
    const conds = ruleConditions(rules, 'error-rate', (t) => errorRateConditions(RATES, t));
    const pending = new Map<string, number>();
    const first = gateConditions(pending, conds, (c) => conditionForSeconds(rules, c), 0);
    expect(new Set(first.map((c) => c.ruleId))).toEqual(new Set(['fast']));
    const later = gateConditions(pending, conds, (c) => conditionForSeconds(rules, c), 300_000);
    expect(new Set(later.map((c) => c.ruleId))).toEqual(new Set(['fast', 'slow']));
    // Ruleless conditions use the catalog hold.
    expect(conditionForSeconds([], cond())).toBe(300);
  });
});

describe('incidentAllowed (a muted rule records but opens no incident)', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  const later = new Date(now + 60 * 60_000);
  const c = { signal: 'service-down' as const, resource: 'service:storefront_checkout' };

  it('blocks a muted rule, allows it again once the mute has passed', () => {
    expect(incidentAllowed([rule({ id: 'r', signal: 'service-down', mutedUntil: later })], { ...c, ruleId: 'r' }, now)).toBe(false);
    expect(incidentAllowed([rule({ id: 'r', signal: 'service-down', mutedUntil: new Date(now - 1) })], { ...c, ruleId: 'r' }, now)).toBe(true);
  });

  it('for a fanned-out signal, any un-muted covering rule is enough', () => {
    const rules = [
      rule({ id: 'muted', signal: 'db-failover', mutedUntil: later }),
      rule({ id: 'other-app', signal: 'db-failover', selector: { app: 'blog' } }),
    ];
    expect(incidentAllowed(rules, { signal: 'db-failover', resource: 'db:storefront/pg' }, now)).toBe(false);
    rules.push(rule({ id: 'shop', signal: 'db-failover', selector: { app: 'storefront' } }));
    expect(incidentAllowed(rules, { signal: 'db-failover', resource: 'db:storefront/pg' }, now)).toBe(true);
    expect(incidentAllowed([], { signal: 'db-failover', resource: 'db:x/pg' }, now)).toBe(true);
  });
});

describe('conditionKey / subjectKey', () => {
  it('dedupes per rule + resource; the incident axis is signal + resource', () => {
    expect(conditionKey(cond())).toBe('-|node-offline|node:w1');
    expect(conditionKey(cond({ ruleId: 'r1' }))).toBe('r1|node-offline|node:w1');
    expect(subjectKey(cond({ ruleId: 'r1' }))).toBe('node-offline|node:w1');
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

describe('cost-budget (owner decision Q6)', () => {
  const rule = (over: Partial<RuleLike> = {}): RuleLike => ({
    id: 'budget',
    signal: 'cost-budget',
    threshold: 80,
    forSeconds: 0,
    enabled: true,
    selector: {},
    mutedUntil: null,
    ...over,
  });

  it('never fires without a budget', () => {
    expect(budgetConditions(10_000, null, 80)).toEqual([]);
    expect(budgetConditions(10_000, 0, 80)).toEqual([]);
  });

  it('fires one workspace condition when the projected month reaches the rule threshold', () => {
    const out = ruleConditions([rule()], 'cost-budget', (t) => budgetConditions(255, 300, t));
    expect(out).toEqual([
      {
        signal: 'cost-budget',
        resource: 'org:budget',
        severity: 'warning',
        message: 'On track to spend $255 this month — 85% of the $300 budget (warns at 80%)',
        ruleId: 'budget',
      },
    ]);
  });

  it('honours the rule threshold (the warn-at %) and a disabled rule', () => {
    expect(ruleConditions([rule({ threshold: 90 })], 'cost-budget', (t) => budgetConditions(255, 300, t))).toEqual([]);
    expect(ruleConditions([rule({ enabled: false })], 'cost-budget', (t) => budgetConditions(255, 300, t))).toEqual([]);
  });

  it('resolves when the month drops back: a level signal whose condition clears', () => {
    expect(LEVEL_SIGNALS).toContain('cost-budget');
    const pending = new Map<string, number>();
    const firing = ruleConditions([rule()], 'cost-budget', (t) => budgetConditions(255, 300, t));
    expect(gateConditions(pending, firing, () => 0, 1_000)).toHaveLength(1);
    // Next tick a server price drops: no condition, so the open event's key is no longer active.
    const next = ruleConditions([rule()], 'cost-budget', (t) => budgetConditions(200, 300, t));
    expect(next).toEqual([]);
    expect(new Set(next.map(conditionKey)).has(conditionKey(firing[0]!))).toBe(false);
  });
});
