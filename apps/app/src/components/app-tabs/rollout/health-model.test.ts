import { describe, expect, test } from 'bun:test';
import { askWords, healthWords, secs } from './health-model';

describe('health check in plain words', () => {
  test('an HTTP probe reads as a GET with its port', () => {
    expect(askWords(['CMD', 'wget', '-qO-', 'http://localhost:3000/health'])).toEqual({ ask: 'GET /health', sub: 'on port 3000' });
    expect(askWords(['CMD-SHELL', 'curl -fsS http://127.0.0.1/healthz?deep=1 || exit 1'])).toEqual({ ask: 'GET /healthz?deep=1', sub: null });
  });

  test('a command probe says what it runs', () => {
    expect(askWords(['CMD', 'pg_isready', '-U', 'app']).ask).toBe('runs pg_isready -U app');
  });

  test('set fields are the app’s, missing ones are Docker’s defaults', () => {
    const w = healthWords({ test: ['CMD', 'wget', '-qO-', 'http://localhost:8080/health'], intervalNs: 10e9, startPeriodNs: 15e9, retries: 3 });
    expect(w.kind).toBe('check');
    expect(w.facts).toEqual([
      { label: 'Every', value: '10 s', dflt: false },
      { label: 'Give up after', value: '30 s', dflt: true },
      { label: 'Unhealthy after', value: '3 misses', dflt: false },
      { label: 'Grace on start', value: '15 s', dflt: false },
    ]);
  });

  test('no check and a disabled check are told apart', () => {
    expect(healthWords(undefined).kind).toBe('none');
    expect(healthWords({ disable: true }).kind).toBe('off');
    expect(healthWords({ test: ['NONE'] }).kind).toBe('off');
  });

  test('durations', () => {
    expect(secs(120)).toBe('2 min');
    expect(secs(1.5)).toBe('1.5 s');
  });
});
