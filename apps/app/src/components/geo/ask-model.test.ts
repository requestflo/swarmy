import { describe, expect, test } from 'bun:test';
import { haversineKm, regionCoord } from '@swarmy/dns/steer';
import { ASK_FROM, arcPath, askAnswer, mapPct, mapXY, type AskEndpoint } from './ask-model';

const EDGES: AskEndpoint[] = [
  { region: 'us-east', ip: '203.0.113.10', healthy: true, name: 'mgr-1' },
  { region: 'eu-west', ip: '198.51.100.10', healthy: true, name: 'mgr-2' },
  { region: 'us-west', ip: '203.0.113.40', healthy: false, name: 'wkr-3' },
];

describe('ask from anywhere', () => {
  test('every place on the map is one the engine can locate', () => {
    for (const r of ASK_FROM) expect(regionCoord(r.id)).toBeDefined();
  });

  test('the map projection is the shared equirectangular frame', () => {
    expect(mapXY({ lat: 90, lon: -180 })).toEqual({ x: 0, y: 0 });
    expect(mapXY({ lat: 0, lon: 0 })).toEqual({ x: 480, y: 240 });
    const p = mapPct({ lat: 0, lon: 0 });
    expect(p.left).toBe(50);
    expect(p.top).toBeCloseTo(((240 - 36) / 372) * 100);
    expect(arcPath({ lat: 0, lon: 0 }, { lat: 0, lon: 90 })).toMatch(/^M480\.0 240\.0 Q /);
  });

  test('the nearest healthy edge, with the km the engine ranks by', () => {
    const a = askAnswer('eu', { answers: [{ type: 'A', value: '198.51.100.10', ttl: 30 }, { type: 'A', value: '203.0.113.10', ttl: 30 }], rcode: 'NOERROR', steered: true, degraded: false }, EDGES);
    expect(a.edge?.name).toBe('mgr-2');
    expect(a.km).toBe(Math.round(haversineKm(regionCoord('eu')!, regionCoord('eu-west')!)));
    expect(a.word).toBe('nearest');
    expect(a.also).toEqual(['mgr-1']);
    expect(a.why).toContain('mgr-1 is in the answer too');
  });

  test('a nearer edge that is down is named as the reason', () => {
    // From North America: wkr-3 (down) is named only if it really is nearer than mgr-1.
    const na = askAnswer('us', { answers: [{ type: 'A', value: '203.0.113.10', ttl: 30 }], rcode: 'NOERROR', steered: true, degraded: false }, EDGES);
    const dEast = haversineKm(regionCoord('us')!, regionCoord('us-east')!);
    const dWest = haversineKm(regionCoord('us')!, regionCoord('us-west')!);
    expect(na.word).toBe(dWest < dEast ? 'rerouted' : 'nearest');
    const down = EDGES.map((e) => (e.name === 'mgr-2' ? { ...e, healthy: false } : e));
    const eu = askAnswer('eu', { answers: [{ type: 'A', value: '203.0.113.10', ttl: 60 }], rcode: 'NOERROR', steered: true, degraded: false }, down);
    expect(eu.word).toBe('rerouted');
    expect(eu.why).toContain('mgr-2 is nearer but isn’t healthy');
    expect(eu.why).toContain('60 s');
  });

  test('degraded spill and no answer say so', () => {
    const spill = askAnswer('ap', { answers: [{ type: 'A', value: '203.0.113.40', ttl: 30 }], rcode: 'NOERROR', steered: true, degraded: true }, EDGES);
    expect(spill.word).toBe('everyone');
    const none = askAnswer('ap', { answers: [], rcode: 'NXDOMAIN', steered: false, degraded: false }, EDGES);
    expect(none).toMatchObject({ edge: null, km: null, word: 'no answer' });
  });
});
