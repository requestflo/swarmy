import { describe, expect, it } from 'bun:test';
import { MINUTE_MS, type TrafficCell } from '@swarmy/core';
import { lastEdgeRequestMs, sleepDecision } from './scale-to-zero.core';

const T0 = 1_790_000_000_000 - (1_790_000_000_000 % MINUTE_MS);
const cell = (minutesAgo: number, host: string, requests: number): TrafficCell => ({
  t: T0 - minutesAgo * MINUTE_MS,
  nodeId: 'edge-1',
  host,
  requests,
  errors5xx: 0,
});

describe('lastEdgeRequestMs', () => {
  const hosts = new Set(['shop.example.com']);

  it('takes the end of the newest minute with requests to one of the hosts', () => {
    const cells = [cell(9, 'shop.example.com', 4), cell(3, 'shop.example.com', 1), cell(1, 'blog.example.com', 50)];
    expect(lastEdgeRequestMs(cells, hosts, T0 + 30_000)).toBe(T0 - 2 * MINUTE_MS);
  });

  it('never reports a time after now for the current minute', () => {
    expect(lastEdgeRequestMs([cell(0, 'shop.example.com', 2)], hosts, T0 + 10_000)).toBe(T0 + 10_000);
  });

  it('ignores empty cells and other hosts', () => {
    expect(lastEdgeRequestMs([cell(2, 'shop.example.com', 0), cell(1, 'other.example.com', 9)], hosts, T0)).toBeUndefined();
  });
});

describe('sleepDecision', () => {
  const idleMs = 5 * MINUTE_MS;

  it('keeps a warm service awake while the edge still sees requests (the activator saw only the wake)', () => {
    const now = T0 + 20 * MINUTE_MS;
    expect(sleepDecision({ now, idleMs, activatorAt: T0, edgeAt: now - MINUTE_MS })).toBe('awake');
  });

  it('sleeps once neither signal has seen a request for the idle window', () => {
    const now = T0 + 20 * MINUTE_MS;
    expect(sleepDecision({ now, idleMs, activatorAt: T0, edgeAt: now - 6 * MINUTE_MS })).toBe('sleep');
  });

  it('falls back to the activator alone when the edge reports nothing (older agents)', () => {
    expect(sleepDecision({ now: T0 + 2 * MINUTE_MS, idleMs, activatorAt: T0, edgeAt: undefined })).toBe('awake');
    expect(sleepDecision({ now: T0 + 6 * MINUTE_MS, idleMs, activatorAt: T0, edgeAt: undefined })).toBe('sleep');
  });

  it('starts the clock on first sight rather than sleeping instantly', () => {
    expect(sleepDecision({ now: T0, idleMs, activatorAt: undefined, edgeAt: undefined })).toBe('start-clock');
  });
});
