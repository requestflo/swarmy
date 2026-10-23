import { describe, expect, test } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { restartLine, restartSummary } from './restart-words';

const spec = (order: 'start-first' | 'stop-first', parallelism = 1, health = true): ServiceSpec =>
  ({
    name: 'x',
    image: 'x',
    updateConfig: { order, parallelism },
    ...(health ? { healthcheck: { test: ['CMD', 'true'], intervalNs: 10e9, startPeriodNs: 10e9 } } : {}),
  }) as ServiceSpec;

describe('restartLine', () => {
  test('several copies roll one at a time', () => {
    expect(restartLine('api', 2, spec('stop-first')).words).toBe('2 copies · one at a time');
  });
  test('start-first says it starts new before stopping old', () => {
    expect(restartLine('checkout', 1, spec('start-first')).words).toBe('1 copy · starts new before stopping old');
  });
  test('one stop-first copy is a gap, honestly', () => {
    const l = restartLine('worker', 1, spec('stop-first'));
    expect(l.gap).toBe(true);
    expect(l.words).toBe('1 copy · a short gap while it restarts');
  });
  test('no spec falls back to Docker defaults (stop-first, one at a time)', () => {
    expect(restartLine('web', 3, null).words).toBe('3 copies · one at a time');
  });
});

describe('restartSummary', () => {
  test('time only when every service has a health check to time it by', () => {
    expect(restartSummary([restartLine('api', 2, spec('stop-first'))])).toBe('~40 s · no downtime');
    expect(restartSummary([restartLine('api', 2, spec('stop-first')), restartLine('w', 2, spec('stop-first', 1, false))])).toBe('no downtime');
  });
  test('names the services with a gap', () => {
    expect(restartSummary([restartLine('worker', 1, spec('stop-first'))])).toBe('~20 s · worker has a short gap');
  });
});
