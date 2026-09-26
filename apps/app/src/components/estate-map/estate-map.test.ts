import { describe, expect, test } from 'bun:test';
import type { IncidentView, NodeSummary, ReleaseView, ServiceSummary, TrafficNowView } from '@swarmy/core';
import type { AppItem } from '@/components/apps/use-apps';
import { cardHeight, groupByRegion, layoutMap, TOP, type GroupInput, type PlacedBlob } from './map-layout';
import { flowFor, flowLabel, flowsFor, regionArea, trafficByRegion, visitorsLine } from './map-flows';
import { backupRuns, DAY_MS, groupTicks, rewindStart, rewindTicks } from './rewind-ticks';
import { busiest, partsWords, reachNote, roleWords, serverApps } from './server-words';

const H = cardHeight({ apps: 2, notes: 0 });
const group = (region: string | null, lat: number | null, lon: number | null, n = 1): GroupInput => ({
  region,
  lat,
  lon,
  cards: Array.from({ length: n }, (_, i) => ({ id: `${region}-${i}`, h: H })),
});

const touching = (a: PlacedBlob, b: PlacedBlob): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('groupByRegion', () => {
  test('labelled regions first, alphabetical; unlabelled last', () => {
    const g = groupByRegion([{ region: 'us-east' }, { region: null }, { region: 'eu-west' }, { region: 'us-east' }, { region: ' ' }]);
    expect(g.map((x) => [x.region, x.servers.length])).toEqual([
      ['eu-west', 1],
      ['us-east', 2],
      [null, 2],
    ]);
  });
});

describe('layoutMap', () => {
  const groups = [
    group('us-west', 45.6, -121.2),
    group('us-east', 39, -77.5, 2),
    group('eu-west', 53.3, -6.3, 2),
    group('ap-south', 19.1, 72.9),
    group(null, null, null),
  ];

  test('nothing overlaps and everything stays inside the canvas', () => {
    for (const width of [760, 1100]) {
      const m = layoutMap(groups, width);
      for (let i = 0; i < m.blobs.length; i++) {
        const b = m.blobs[i]!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(TOP);
        expect(b.x + b.w).toBeLessThanOrEqual(m.width);
        expect(b.y + b.h).toBeLessThanOrEqual(m.height);
        for (let j = i + 1; j < m.blobs.length; j++) expect(touching(b, m.blobs[j]!)).toBe(false);
      }
      expect(m.width).toBe(width);
    }
  });

  test('rough geography: west stays left of east when there is room', () => {
    const m = layoutMap(groups, 1400);
    const x = (r: string) => m.blobs.find((b) => b.region === r)!.x;
    expect(x('us-west')).toBeLessThan(x('eu-west'));
    expect(x('eu-west')).toBeLessThan(x('ap-south'));
  });

  test('blobs stay out of a kept-clear box (the floating card)', () => {
    const card = { x: 760, y: 0, w: 380, h: 640 };
    const m = layoutMap(groups, 1140, [card]);
    for (const b of m.blobs) expect(b.x + b.w <= card.x || b.y >= card.y + card.h).toBe(true);
    expect(m.height).toBeGreaterThanOrEqual(640);
  });

  test('the unlabelled group goes below the geography', () => {
    const m = layoutMap(groups, 1100);
    const none = m.blobs.find((b) => b.region === null)!;
    const geo = m.blobs.filter((b) => b.region !== null);
    expect(none.y).toBeGreaterThanOrEqual(Math.max(...geo.map((b) => b.y + b.h)));
  });

  test('cards sit inside their blob at full size, two to a row', () => {
    const m = layoutMap([group('eu-west', 53, -6, 3)], 900);
    const b = m.blobs[0]!;
    expect(b.cards).toHaveLength(3);
    for (const c of b.cards) {
      expect(c.x).toBeGreaterThanOrEqual(b.x);
      expect(c.x + c.w).toBeLessThanOrEqual(b.x + b.w);
      expect(c.y + c.h).toBeLessThanOrEqual(b.y + b.h);
    }
    expect(b.cards[2]!.y).toBeGreaterThan(b.cards[0]!.y);
  });

  test('deterministic, and an empty estate has a height', () => {
    expect(layoutMap(groups, 1000)).toEqual(layoutMap(groups, 1000));
    expect(layoutMap([], 800).height).toBeGreaterThan(0);
  });

  test('card height grows with apps and notes', () => {
    expect(cardHeight({ apps: 3, notes: 1 })).toBeGreaterThan(cardHeight({ apps: 1, notes: 0 }));
    expect(cardHeight({ apps: 0, notes: 0 })).toBe(cardHeight({ apps: 1, notes: 0 }));
  });
});

describe('flows', () => {
  const now = (regions: TrafficNowView['regions']): TrafficNowView =>
    ({ sampledAt: 1, windowMinutes: 5, unit: 'requests/min', totals: { requestsPerMin: 1, errors5xxPerMin: 0, errorShare: 0, state: 'reporting' }, regions, apps: [] }) as TrafficNowView;
  const blob = (region: string | null, x: number): PlacedBlob => ({ region, x, y: 120, w: 280, h: 200, cards: [] });

  test('plain words from the region label', () => {
    expect(regionArea('eu-west')).toBe('EU');
    expect(regionArea('us-east-1')).toBe('US');
    expect(regionArea('home-lab')).toBe('home-lab');
    expect(flowLabel('eu-west', 434.4)).toBe('EU visitors · 434/min');
    expect(flowLabel(null, 4.25)).toBe('Visitors · 4.3/min');
    expect(visitorsLine(434)).toBe('434 visitors a minute');
    expect(visitorsLine(null)).toBe('No traffic data yet');
  });

  test('only reporting regions get a flow; no data is not a zero', () => {
    const t = trafficByRegion(
      now([
        { region: 'eu-west', requestsPerMin: 434, errors5xxPerMin: 0, state: 'reporting', edges: [] },
        { region: 'us-west', requestsPerMin: null, errors5xxPerMin: null, state: 'no-data', edges: [] },
      ]),
    );
    expect(t.get('us-west')?.rate).toBeNull();
    const flows = flowsFor([blob('eu-west', 500), blob('us-west', 20), blob('ap-south', 800)], t, { width: 1100 });
    expect(flows.map((f) => f.region)).toEqual(['eu-west']);
    expect(trafficByRegion(undefined).size).toBe(0);
  });

  test('western blobs are fed from the left edge, eastern from the right, the rest from the top', () => {
    expect(flowFor(blob('us-west', 100), 10, { width: 1400 }).from).toBe('left');
    // hugging the left edge: no room for a side route, so it comes from the top
    expect(flowFor(blob('us-west', 20), 10, { width: 1000 }).from).toBe('top');
    const top = flowFor(blob('eu-west', 300), 10, { width: 1000 });
    expect(top.from).toBe('top');
    expect(flowFor(blob('ap-south', 900), 10, { width: 1400 }).from).toBe('right');
    expect(top.d.startsWith('M')).toBe(true);
    expect(top.label.y).toBeLessThan(TOP);
  });

  test('a flow takes a route that crosses no other blob', () => {
    const low: PlacedBlob = { region: 'us-east', x: 300, y: 500, w: 280, h: 200, cards: [] };
    const above: PlacedBlob = { region: 'eu-west', x: 250, y: 120, w: 520, h: 260, cards: [] };
    const f = flowFor(low, 100, { width: 1000 }, [low, above]);
    expect(f.from).toBe('left');
    expect(f.label.x + 250).toBeLessThanOrEqual(1000);
  });

  test('neighbouring top labels step down instead of overprinting', () => {
    const t = new Map([
      ['eu-west', { rate: 434, edges: 1 }],
      ['eu-central', { rate: 60, edges: 1 }],
    ]);
    const narrow = (region: string, x: number): PlacedBlob => ({ ...blob(region, x), w: 200 });
    const [a, b] = flowsFor([narrow('eu-west', 300), narrow('eu-central', 540)], t, { width: 1400 });
    expect([a!.from, b!.from]).toEqual(['top', 'top']);
    expect(a!.label.y).not.toBe(b!.label.y);
  });
});

describe('rewind ticks', () => {
  const NOW = new Date('2026-09-26T10:42:00').getTime();
  const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const rel = (id: string, h: number, status: ReleaseView['status'] = 'healthy'): ReleaseView =>
    ({ id, stackName: 'storefront', status, images: [{ name: 'web', image: 'ghcr.io/x/web:1.9.0' }], actor: null, strategy: null, healthGate: null, notes: null, createdAt: ago(h) }) as ReleaseView;
  const snap = (id: string, h: number, status = 'SUCCEEDED') => ({ id, volume: `data_${id}`, status, startedAt: ago(h) });
  const inc = (id: string, h: number): IncidentView =>
    ({ id, title: 'analytics is slow', status: 'open', severity: 'minor', summary: null, openedAt: ago(h), resolvedAt: null, durationSec: 0, eventCount: 1, lastEventAt: null }) as IncidentView;

  test('the last 24 hours only, oldest first, positioned on the day', () => {
    const ticks = rewindTicks({ releases: [rel('r1', 2), rel('r0', 30)], snapshots: [snap('a', 7.7)], incidents: [inc('i1', 1)], now: NOW });
    expect(ticks.map((t) => t.kind)).toEqual(['backup', 'deploy', 'incident']);
    expect(ticks.every((t) => t.pos >= 0 && t.pos <= 1)).toBe(true);
    expect(ticks[2]!.pos).toBeCloseTo(23 / 24, 5);
    expect(ticks[2]!.link).toEqual({ to: '/incidents/$incidentId', params: { incidentId: 'i1' }, label: 'Open incident' });
    expect(ticks[1]!.link.params).toEqual({ name: 'storefront' });
  });

  test('a night of snapshots is one backup tick, failures counted', () => {
    const snaps = [snap('a', 7.7), snap('b', 7.65), snap('c', 7.6, 'FAILED'), snap('d', 2)];
    expect(backupRuns(snaps, NOW - DAY_MS, NOW)).toHaveLength(2);
    const ticks = rewindTicks({ snapshots: snaps, now: NOW });
    expect(ticks.map((t) => t.title)).toEqual(['2 of 3 saved, 1 failed', 'Backed up data_d']);
  });

  test('ticks that would overlap share one target', () => {
    const ticks = rewindTicks({ releases: [rel('r1', 0.05), rel('r2', 12)], incidents: [inc('i1', 0.02)], snapshots: [snap('a', 0.5)], now: NOW });
    const groups = groupTicks(ticks);
    expect(groups.map((g) => g.ticks.length)).toEqual([1, 3]);
    expect(groups[1]!.ticks.map((t) => t.kind)).toEqual(['backup', 'deploy', 'incident']);
  });

  test('axis words', () => {
    expect(rewindStart(NOW)).toBe('yesterday 10:42');
    expect(rewindTicks({ now: NOW })).toEqual([]);
  });
});

describe('server words', () => {
  const node = (over: Partial<NodeSummary>): NodeSummary =>
    ({ id: 'n1', name: 'london-1', role: 'worker', status: 'online', resources: { cpus: 2, memBytes: 4 * 1024 ** 3 }, live: { cpuPercent: 21, memPercent: 38 }, publicIp: '1.2.3.4', ...over }) as NodeSummary;

  test('roles as words', () => {
    expect(roleWords(node({ ingress: true, role: 'manager' }))).toBe('edge · controller');
    expect(roleWords(node({}))).toBe('worker');
  });

  test('the ring shows the busier of CPU and memory; offline shows nothing', () => {
    expect(busiest(node({}))).toEqual({ pct: 38, which: 'memory' });
    expect(busiest(node({ live: { cpuPercent: 71.6, memPercent: 40 } }))).toEqual({ pct: 72, which: 'CPU' });
    expect(busiest(node({ live: null }))).toBeNull();
  });

  test('parts with copies, trimmed after three', () => {
    const s = (name: string, running: number) => ({ name, replicas: { desired: running, running } });
    expect(partsWords([s('web', 2), s('api', 1)])).toBe('web ×2 api');
    expect(partsWords([s('a', 1), s('b', 1), s('c', 1), s('d', 1), s('e', 1)])).toBe('a b c +2');
  });

  test('apps on a server keep inventory order; the system stack is not an app', () => {
    const app = (name: string, tone: AppItem['words']['tone'], word = 'Online'): AppItem =>
      ({ name, words: { tone, word, say: '', tech: '', attention: tone === 'warn' } }) as AppItem;
    const svc = (id: string, name: string): ServiceSummary => ({ id, name, replicas: { desired: 1, running: 1 }, stackId: null }) as ServiceSummary;
    const stackOf = new Map([
      ['s1', 'storefront'],
      ['s2', 'analytics'],
      ['s3', 'swarmy-system'],
    ]);
    const rows = serverApps([svc('s2', 'web'), svc('s1', 'api'), svc('s3', 'caddy')], [app('storefront', 'ok'), app('analytics', 'warn', 'Needs you')], stackOf);
    expect(rows).toEqual([
      { app: 'storefront', parts: 'api', tone: 'ok', word: null },
      { app: 'analytics', parts: 'web', tone: 'warn', word: 'needs you' },
    ]);
  });

  test('reachability note from the public address', () => {
    expect(reachNote(node({}), true)).toBeNull();
    expect(reachNote(node({ publicIp: null }), true)).toBe('private network only');
    expect(reachNote(node({ publicIp: null }), false)).toBe('no public address');
  });
});
