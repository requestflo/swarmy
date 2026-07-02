import { describe, expect, it } from 'bun:test';
import {
  composeHealth,
  dbLagsFromLabels,
  matchRedToServices,
  parseLagSeconds,
  type HealthSignals,
} from './health-summary';

const svc = (name: string, desired: number, running: number, scaleToZero = false) => ({
  name,
  desired,
  running,
  scaleToZero,
});

describe('composeHealth', () => {
  it('is healthy with no reasons when everything runs at desired', () => {
    const out = composeHealth({ services: [svc('web', 2, 2), svc('api', 3, 3)] });
    expect(out).toEqual({ status: 'healthy', reasons: [] });
  });

  it('is unknown when the scope has no services and no signals', () => {
    expect(composeHealth({ services: [] }).status).toBe('unknown');
  });

  it('marks a zero-running service down and the scope down when ALL are down', () => {
    const one = composeHealth({ services: [svc('web', 2, 0), svc('api', 1, 2)] });
    expect(one.status).toBe('degraded');
    expect(one.reasons[0]).toBe('service web is down (0/2 tasks running)');

    const all = composeHealth({ services: [svc('web', 2, 0), svc('api', 1, 0)] });
    expect(all.status).toBe('down');
  });

  it('reports task shortfall as degraded', () => {
    const out = composeHealth({ services: [svc('api', 3, 1)] });
    expect(out.status).toBe('degraded');
    expect(out.reasons).toEqual(['service api running 1/3 tasks']);
  });

  it('treats scale-to-zero services as waking, never down', () => {
    const out = composeHealth({ services: [svc('worker', 1, 0, true)] });
    expect(out.status).toBe('degraded');
    expect(out.reasons[0]).toContain('still waking');
    // idle (desired 0) scale-to-zero is not a reason at all.
    expect(composeHealth({ services: [svc('worker', 0, 0, true)] }).reasons).toEqual([]);
  });

  it('emits db lag reasons only above the 10s target', () => {
    const out = composeHealth({
      services: [svc('db', 1, 1)],
      dbLags: [
        { member: 'orders-db-1', lagSeconds: 12 },
        { member: 'orders-db-2', lagSeconds: 3 },
      ],
    });
    expect(out.status).toBe('degraded');
    expect(out.reasons).toEqual(['database replica lag 12s (member orders-db-1, target <10s)']);
  });

  it('emits failed-job and rising-depth queue reasons', () => {
    const out = composeHealth({
      services: [svc('worker', 1, 1)],
      queues: [
        { queue: 'emails', wait: 340, failed: 0, prevWait: 120 },
        { queue: 'thumbs', wait: 4, failed: 2 },
        { queue: 'quiet', wait: 2, failed: 0, prevWait: 9 }, // below rising floor
      ],
    });
    expect(out.reasons).toEqual([
      'queue thumbs has 2 failed jobs',
      'queue depth rising (emails: 340 waiting)',
    ]);
  });

  it('does not call a queue rising without a previous observation', () => {
    const out = composeHealth({
      services: [svc('worker', 1, 1)],
      queues: [{ queue: 'emails', wait: 900, failed: 0 }],
    });
    expect(out.reasons).toEqual([]);
  });

  it('emits RED reasons above targets, prefixed only in multi-service scopes', () => {
    const single = composeHealth({
      services: [svc('checkout', 1, 1)],
      red: [{ service: 'checkout', p95Ms: 1800, errorRate: 0.062 }],
    });
    expect(single.reasons).toEqual([
      'error rate 6.2% (target <5.0%)',
      'p95 latency 1.8s (target <1.5s)',
    ]);

    const multi = composeHealth({
      services: [svc('checkout', 1, 1), svc('web', 1, 1)],
      red: [{ service: 'checkout', p95Ms: 1800, errorRate: 0.01 }],
    });
    expect(multi.reasons).toEqual(['checkout: p95 latency 1.8s (target <1.5s)']);
  });

  it('keeps healthy RED rows quiet', () => {
    const out = composeHealth({
      services: [svc('web', 1, 1)],
      red: [{ service: 'web', p95Ms: 240, errorRate: 0.004 }],
    });
    expect(out).toEqual({ status: 'healthy', reasons: [] });
  });

  it('lists offline nodes as degraded reasons', () => {
    const out = composeHealth({ services: [svc('web', 1, 1)], offlineNodes: ['hetzner-3'] });
    expect(out.status).toBe('degraded');
    expect(out.reasons).toEqual(['node hetzner-3 offline']);
  });

  it('collector trouble is info-only: listed but never degrades the status', () => {
    const out = composeHealth({
      services: [svc('web', 1, 1)],
      collector: { enabled: true, failed: false, storeReachable: false },
    });
    expect(out.status).toBe('healthy');
    expect(out.reasons).toEqual([
      'telemetry store unreachable — latency and error-rate checks are blind',
    ]);
    // Suite off = silence, not a warning.
    const off = composeHealth({
      services: [svc('web', 1, 1)],
      collector: { enabled: false, failed: false, storeReachable: false },
    });
    expect(off.reasons).toEqual([]);
  });

  it('orders reasons worst-first: down, shortfall, nodes, lag, queues, RED, info', () => {
    const sig: HealthSignals = {
      services: [svc('web', 2, 0), svc('api', 3, 2)],
      dbLags: [{ member: 'db-1', lagSeconds: 15 }],
      queues: [{ queue: 'emails', wait: 340, failed: 1, prevWait: 100 }],
      red: [{ service: 'api', p95Ms: 1800, errorRate: 0.09 }],
      offlineNodes: ['node-b'],
      collector: { enabled: true, failed: true, storeReachable: false },
    };
    const out = composeHealth(sig);
    expect(out.status).toBe('degraded');
    expect(out.reasons).toEqual([
      'service web is down (0/2 tasks running)',
      'service api running 2/3 tasks',
      'node node-b offline',
      'database replica lag 15s (member db-1, target <10s)',
      'queue emails has 1 failed job',
      'queue depth rising (emails: 340 waiting)',
      'api: error rate 9.0% (target <5.0%)',
      'api: p95 latency 1.8s (target <1.5s)',
      'telemetry collector failed to deploy — latency and error-rate checks are blind',
    ]);
  });
});

describe('parseLagSeconds', () => {
  it('accepts explicit units', () => {
    expect(parseLagSeconds('12s')).toBe(12);
    expect(parseLagSeconds('850ms')).toBe(0.85);
    expect(parseLagSeconds('12000MS')).toBe(12);
  });

  it('reads bare numbers as seconds below 600, milliseconds above', () => {
    expect(parseLagSeconds('12')).toBe(12);
    expect(parseLagSeconds('0.5')).toBe(0.5);
    expect(parseLagSeconds('12000')).toBe(12);
  });

  it('rejects garbage', () => {
    expect(parseLagSeconds('soon')).toBeNull();
    expect(parseLagSeconds('')).toBeNull();
    expect(parseLagSeconds('-4')).toBeNull();
    expect(parseLagSeconds(undefined)).toBeNull();
  });
});

describe('dbLagsFromLabels', () => {
  it('extracts every swarmy.db.lag.<member> label', () => {
    const lags = dbLagsFromLabels({
      'swarmy.db.lag.orders-db-1': '12',
      'swarmy.db.lag.orders-db-2': '900ms',
      'swarmy.db.role': 'replica',
      'swarmy.db.lag.': '5', // no member name — dropped
      'swarmy.db.lag.broken': 'nope', // unparseable — dropped
    });
    expect(lags).toEqual([
      { member: 'orders-db-1', lagSeconds: 12 },
      { member: 'orders-db-2', lagSeconds: 0.9 },
    ]);
  });
});

describe('matchRedToServices', () => {
  const rows = [
    { service_name: 'web', error_rate: 0.01, p95_ms: 200 },
    { service_name: 'shop_api', error_rate: 0.02, p95_ms: 300 },
    { service_name: 'other', error_rate: 0.5, p95_ms: 9000 },
  ];

  it('matches otel names by full Docker name or bare in-stack name', () => {
    const matched = matchRedToServices(rows, [
      { name: 'shop_web', stack: 'shop' }, // bare name "web" matches
      { name: 'shop_api', stack: 'shop' }, // full name matches
    ]);
    expect(matched.map((m) => m.service)).toEqual(['web', 'shop_api']);
    expect(matched[0]).toEqual({ service: 'web', p95Ms: 200, errorRate: 0.01 });
  });

  it('drops rows for services outside the scope', () => {
    expect(matchRedToServices(rows, [{ name: 'web', stack: '(ungrouped)' }])).toHaveLength(1);
  });
});
