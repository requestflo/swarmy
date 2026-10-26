import { describe, expect, it } from 'bun:test';
import { logsRangeFor, requestIdLink } from './replay-request-id-model';
import { buildTimeline } from './replay-timeline';

const MIN = 60_000;
const T0 = Date.parse('2026-10-26T10:00:00Z');
const req = (t: number, payload: Record<string, unknown>) => ({ type: 5, timestamp: T0 + t, data: { tag: 'swarmy.request', payload } });

describe('buildTimeline — the failed request carries its id', () => {
  it('keeps an id-shaped requestId; drops anything else', () => {
    const tl = buildTimeline({
      events: [
        { type: 4, timestamp: T0, data: { href: 'https://shop.example.com/' } },
        req(1000, { method: 'POST', url: '/api/checkout', status: 500, traceId: 'a'.repeat(32), requestId: '4f2a9c1e-7b3d-4e8a-9f10-2c5d6e7f8a9b' }),
        req(2000, { method: 'GET', url: '/api/cart', status: 502, requestId: '<img src=x onerror=alert(1)>' }),
        req(3000, { method: 'GET', url: '/api/ok', status: 200 }),
      ],
      requests: [],
      logs: [],
      errors: [],
    });
    expect(tl.requests.map((r) => [r.badge, r.main, r.requestId])).toEqual([
      ['500', 'POST /api/checkout', '4f2a9c1e-7b3d-4e8a-9f10-2c5d6e7f8a9b'],
      ['502', 'GET /api/cart', undefined],
      ['200', 'GET /api/ok', undefined],
    ]);
  });
});

describe('logsRangeFor / requestIdLink — the smallest logs window that reaches the request', () => {
  it('picks 15 m, 1 h or 24 h, and nothing past that', () => {
    expect(logsRangeFor(5 * MIN)).toBe('15m');
    expect(logsRangeFor(14.5 * MIN)).toBe('1h');
    expect(logsRangeFor(50 * MIN)).toBe('1h');
    expect(logsRangeFor(59.5 * MIN)).toBe('24h');
    expect(logsRangeFor(25 * 60 * MIN)).toBeNull();
    expect(logsRangeFor(-1)).toBeNull();
  });
  it('links only when the app sends telemetry', () => {
    const now = T0 + 10 * MIN;
    expect(requestIdLink('req-1', T0, now, true)).toEqual({ q: 'req-1', range: '15m' });
    expect(requestIdLink('req-1', T0, now, false)).toBeNull();
    expect(requestIdLink('req-1', T0 - 2 * 24 * 60 * MIN, now, true)).toBeNull();
  });
});
