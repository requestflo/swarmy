import { describe, expect, it } from 'bun:test';
import type { TrafficHostView, TrafficNowView } from '@swarmy/core';
import { countedAtEdge, hostVisits } from './host-visits';

const row = (host: string, perMin: number, edges: Array<[string, number]>): TrafficHostView => ({
  host,
  app: 'shop',
  requestsPerMin: perMin,
  errors5xxPerMin: perMin / 100,
  errorShare: 0.01,
  edges: edges.map(([nodeId, requestsPerMin]) => ({ nodeId, requestsPerMin })),
});

const now = (hosts: TrafficHostView[], state: 'reporting' | 'no-data' = 'reporting'): TrafficNowView =>
  ({ windowMinutes: 5, totals: { state }, hosts }) as unknown as TrafficNowView;

describe('hostVisits', () => {
  const t = now([row('shop.example.com', 348, [['a', 210], ['b', 138]]), row('pr-1.preview.example.com', 4, [['a', 4]]), row('pr-2.preview.example.com', 2, [['b', 2]])]);

  it('reads one address, case and trailing dot aside, with its split by edge', () => {
    expect(hostVisits(t, 'SHOP.example.com.')).toEqual({
      perMin: 348,
      errors5xxPerMin: 3.5,
      edges: [{ nodeId: 'a', requestsPerMin: 210 }, { nodeId: 'b', requestsPerMin: 138 }],
      windowMinutes: 5,
    });
  });

  it('a wildcard adds up the hosts one label under it', () => {
    expect(hostVisits(t, '*.preview.example.com')).toMatchObject({ perMin: 6, edges: [{ nodeId: 'a', requestsPerMin: 4 }, { nodeId: 'b', requestsPerMin: 2 }] });
  });

  it('a real zero only when the edges reported and counted none for it', () => {
    expect(hostVisits(t, 'quiet.example.com')).toMatchObject({ perMin: 0, edges: [] });
    expect(hostVisits(now([row('_other', 9, [['a', 9]])]), 'quiet.example.com')).toBeNull();
  });

  it('no number with nothing reported, or off the edge', () => {
    expect(hostVisits(undefined, 'shop.example.com')).toBeNull();
    expect(hostVisits(now([], 'no-data'), 'shop.example.com')).toBeNull();
    expect(hostVisits(t, 'shop.example.com', false)).toBeNull();
    expect([countedAtEdge(null, 'caddy'), countedAtEdge('cloudflared', 'caddy'), countedAtEdge(null, 'none')]).toEqual([true, false, false]);
  });
});
