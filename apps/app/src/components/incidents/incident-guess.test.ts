import { describe, expect, test } from 'bun:test';
import type { ReleaseView } from '@swarmy/core';
import { bestGuess, durationWords, slowestSpan, type ServerSignal, type SlowSpan } from './incident-guess';
import { incidentMetric, incidentScope } from './incident-scope';

const NOW = Date.parse('2026-09-26T18:07:00Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

function rel(id: string, status: ReleaseView['status'], tag: string, min: number): ReleaseView {
  return {
    id, stackName: 'storefront', status, images: [{ name: 'web', image: `ghcr.io/northwind/web:${tag}` }],
    actor: 'calum@gomacrae.com', strategy: null, healthGate: null, notes: null, createdAt: ago(min),
  };
}

const releases = [rel('r6', 'deploying', '1.9.0', 2), rel('r5', 'rolled-back', '1.8.3', 60 * 26), rel('r4', 'healthy', '1.8.2', 60 * 27)];
const stripe: SlowSpan = { traceId: 't1', part: 'checkout', name: 'stripe.paymentIntents.create', ms: 10_000 };
const calm: ServerSignal[] = [
  { name: 'wkr-1', status: 'online', live: { cpuPercent: 62, memPercent: 70 } },
  { name: 'wkr-3', status: 'draining', live: { cpuPercent: 12, memPercent: 22 } },
];

describe('bestGuess', () => {
  test('a release just before it opened is the likely cause, with the last healthy one to put back', () => {
    const g = bestGuess({ openedAt: ago(0), releases, slowSpan: stripe, servers: calm });
    expect(g.cause).toBe('deploy');
    expect(g.headline).toBe('Likely the deploy: 1.9.0 went out 2 minutes before this started.');
    expect(g.lines).toEqual(['Trace spans show checkout waiting 10 s on stripe.paymentIntents.create.', 'The servers look normal.']);
    expect(g.putBack?.id).toBe('r4');
    expect(g.traceId).toBe('t1');
  });

  test('a release long before, or after it opened, is not a suspect', () => {
    expect(bestGuess({ openedAt: ago(0), releases: [rel('old', 'healthy', '1.0.0', 45)], slowSpan: null, servers: calm }).cause).toBe('unknown');
    expect(bestGuess({ openedAt: ago(10), releases: [rel('late', 'healthy', '1.0.0', 2)], slowSpan: null, servers: calm }).cause).toBe('unknown');
  });

  test('no healthy earlier release means no put-back', () => {
    const g = bestGuess({ openedAt: ago(0), releases: [rel('r6', 'deploying', '1.9.0', 1)], slowSpan: null, servers: null });
    expect(g.headline).toBe('Likely the deploy: 1.9.0 went out a minute before this started.');
    expect(g.putBack).toBeNull();
    expect(g.lines).toEqual([]);
  });

  test('an offline server is named before a slow span', () => {
    const g = bestGuess({ openedAt: ago(0), releases: [], slowSpan: stripe, servers: [...calm, { name: 'wkr-2', status: 'offline', live: null }] });
    expect(g.cause).toBe('server');
    expect(g.headline).toBe('Likely the server: Server wkr-2 is offline.');
  });

  test('a busy server reads its number', () => {
    const g = bestGuess({ openedAt: ago(0), releases: [], slowSpan: null, servers: [{ name: 'wkr-1', status: 'online', live: { cpuPercent: 93.4, memPercent: 40 } }] });
    expect(g.headline).toBe('Likely the server: Server wkr-1 is busy: CPU at 93%.');
  });

  test('a slow span alone is the guess', () => {
    const g = bestGuess({ openedAt: ago(0), releases: [], slowSpan: stripe, servers: calm });
    expect(g.cause).toBe('trace');
    expect(g.headline).toBe('Likely a slow call: checkout is waiting on stripe.paymentIntents.create.');
  });

  test('nothing matches: "Not sure yet", honestly', () => {
    const g = bestGuess({ openedAt: ago(0), releases: [], slowSpan: null, servers: calm });
    expect(g.headline).toBe('Not sure yet.');
    expect(g.lines).toEqual(['Nothing went out in the 30 minutes before it started.', 'The servers look normal.']);
  });
});

describe('slowestSpan', () => {
  test('picks the span with the most self time, not the root', () => {
    const spans = [
      { span_id: 'a', parent_span_id: '', service_name: 'web', span_name: 'POST /checkout', duration_ms: 10_200 },
      { span_id: 'b', parent_span_id: 'a', service_name: 'checkout', span_name: 'POST /charge', duration_ms: 10_100 },
      { span_id: 'c', parent_span_id: 'b', service_name: 'checkout', span_name: 'stripe.paymentIntents.create', duration_ms: 10_000 },
    ];
    expect(slowestSpan('t', spans)).toEqual({ traceId: 't', part: 'checkout', name: 'stripe.paymentIntents.create', ms: 10_000 });
    expect(slowestSpan('t', [])).toBeNull();
  });

  test('durations read plainly', () => {
    expect(durationWords(240)).toBe('240 ms');
    expect(durationWords(1600)).toBe('1.6 s');
    expect(durationWords(10_000)).toBe('10 s');
  });
});

describe('incidentScope', () => {
  const ctx = { serviceApp: new Map([['checkout', 'storefront']]), apps: ['storefront', 'data'] };
  test('reads app, part, signals and release from the timeline', () => {
    const scope = incidentScope(
      {
        title: 'checkout is down to 1 of 2 copies during the 1.9.0 rollout',
        events: [
          { id: '1', at: ago(1), kind: 'opened', message: 'Incident opened (release:storefront)', meta: { groupKey: 'release:storefront' } },
          { id: '2', at: ago(1), kind: 'alert.fired', message: 'replicas on service:checkout — 1 of 2 running', meta: { signal: 'replicas', releaseId: 'rel-store-6' } },
        ],
      },
      ctx,
    );
    expect(scope).toEqual({ app: 'storefront', part: 'checkout', signals: ['replicas'], releaseId: 'rel-store-6' });
    expect(incidentMetric(scope, 'x')).toBe('errors');
    expect(incidentMetric({ ...scope, signals: ['latency'] }, 'x')).toBe('latency');
    expect(incidentMetric({ ...scope, app: null }, 'x')).toBeNull();
  });

  test('a service alert group key names the part and its app', () => {
    const scope = incidentScope(
      { title: 'Service storefront_checkout disruption', events: [{ id: '1', at: ago(1), kind: 'opened', message: 'Incident opened', meta: { groupKey: 'alert:service:storefront_checkout' } }] },
      ctx,
    );
    expect(scope.app).toBe('storefront');
    expect(scope.part).toBe('checkout');
  });
});
