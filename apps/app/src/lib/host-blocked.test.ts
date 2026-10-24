import { describe, expect, it } from 'bun:test';
import type { TrafficHostView, TrafficNowView } from '@swarmy/core';
import { hostBlocked } from './host-blocked';

const row = (host: string, blocked?: [number, number]): TrafficHostView => ({
  host,
  app: 'shop',
  requestsPerMin: 100,
  errors5xxPerMin: 0,
  errorShare: 0,
  ...(blocked ? { blockedPerMin: blocked[0] + blocked[1], forbiddenPerMin: blocked[0], tooManyPerMin: blocked[1] } : { blockedPerMin: null }),
  edges: [],
});

const now = (hosts: TrafficHostView[], blockedPerMin: number | null = 1, state = 'reporting'): TrafficNowView =>
  ({ windowMinutes: 5, totals: { state, blockedPerMin }, hosts }) as unknown as TrafficNowView;

describe('hostBlocked — 403 + 429 at an address, never a fake zero', () => {
  const t = now([row('shop.example.com', [9, 3]), row('pr-1.preview.example.com', [1, 0]), row('pr-2.preview.example.com', [0.5, 0])]);

  it('reads one address with its 403 / 429 split; a wildcard adds up the hosts under it', () => {
    expect(hostBlocked(t, 'Shop.example.com')).toEqual({ perMin: 12, forbiddenPerMin: 9, tooManyPerMin: 3, windowMinutes: 5 });
    expect(hostBlocked(t, '*.preview.example.com')).toMatchObject({ perMin: 1.5, forbiddenPerMin: 1.5, tooManyPerMin: 0 });
  });

  it('a real zero only when the edges report status codes and counted none here', () => {
    expect(hostBlocked(t, 'quiet.example.com')).toMatchObject({ perMin: 0 });
    expect(hostBlocked(now([], null), 'quiet.example.com')).toBeNull();
    expect(hostBlocked(now([row('_other', [1, 0])]), 'quiet.example.com')).toBeNull();
  });

  it('no number from an older agent, with nothing reported, or off the edge', () => {
    expect(hostBlocked(now([row('shop.example.com')], null), 'shop.example.com')).toBeNull();
    expect(hostBlocked(undefined, 'shop.example.com')).toBeNull();
    expect(hostBlocked(now([], null, 'no-data'), 'shop.example.com')).toBeNull();
    expect(hostBlocked(t, 'shop.example.com', false)).toBeNull();
  });
});
