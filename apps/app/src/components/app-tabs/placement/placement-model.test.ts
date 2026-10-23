import { describe, expect, test } from 'bun:test';
import type { InvService, NodeSummary, ServiceDetail } from '@swarmy/core';
import { buildMap, partsById, regionsOf } from './map-model';
import { meaningNotes } from './meaning-model';
import { durableName, volumeRows, withDurable } from './volume-model';

const node = (id: string, region: string | null): NodeSummary => ({ id, name: id, hostname: id, region, status: 'online' }) as unknown as NodeSummary;
const inv = (id: string, name: string, extra: Partial<InvService> = {}): InvService =>
  ({ id, name, stack: 'shop', replicas: { desired: 1, running: 1 }, ...extra }) as InvService;

const nodes = [node('lon-1', 'eu-west'), node('lon-2', 'eu-west'), node('nyc-1', 'us-east'), node('home', null)];
const services = [inv('w', 'shop_web'), inv('w-eu', 'shop_web-eu-west', { regionParent: 'shop_web' }), inv('db', 'shop_db'), inv('x', 'other_api', { stack: 'other' })];
const byNode = new Map([
  ['lon-1', [{ id: 'w-eu' }, { id: 'x' }]],
  ['lon-2', [{ id: 'db' }]],
  ['nyc-1', [{ id: 'w' }]],
  ['home', [{ id: 'w' }]],
]);

describe('placement map', () => {
  test('groups servers by region; a per-region copy is marked as its part; other apps are left out', () => {
    const map = buildMap(nodes, byNode, partsById(services, 'shop'), new Set(['home']));
    expect(map.map((r) => [r.region, r.servers.map((s) => `${s.node.name}:${s.parts.join('+')}`)])).toEqual([
      ['eu-west', ['lon-1:web', 'lon-2:db']],
      ['us-east', ['nyc-1:web']],
      [null, ['home:web']],
    ]);
    expect(regionsOf(map, 'web')).toEqual(['eu-west', 'us-east']);
  });

  test('what this means: spread, single copies, NAT', () => {
    const map = buildMap(nodes, byNode, partsById(services, 'shop'), new Set(['home']));
    const notes = meaningNotes({ part: 'web', declared: [], map, singles: [{ part: 'db', server: 'lon-2', pinned: true }] });
    expect(notes.map((n) => n.tone)).toEqual(['ok', 'info', 'mesh']);
    expect(notes[0]!.text).toContain('Today its copies are in eu-west and us-east');
    expect(notes[1]!.text).toBe('db runs one copy, on lon-2, kept with its data: if that server stops, db waits for it.');
    expect(notes[2]!.text).toContain('home has no public address');
    expect(meaningNotes({ part: 'web', declared: ['eu-west'], map, singles: [] })[0]!.tone).toBe('warn');
  });
});

describe('volumes as rows', () => {
  const detail = (vols: ServiceDetail['volumes'], constraints: string[] = []): ServiceDetail => ({ volumes: vols, constraints, nodeId: null }) as unknown as ServiceDetail;
  test('pinned, roaming, throwaway and host folders', () => {
    const rows = volumeRows('shop', [
      { inv: inv('db', 'shop_db'), detail: detail([{ type: 'volume', source: 'shop_pg', target: '/data', readOnly: false }], ['node.hostname == lon-2']) },
      { inv: inv('w', 'shop_web'), detail: detail([{ type: 'volume', target: '/app/.cache', readOnly: false }, { type: 'bind', source: '/etc/ssl', target: '/ssl', readOnly: true }]) },
      { inv: inv('c', 'shop_cache'), detail: detail([{ type: 'volume', source: 'shop_cache', target: '/data', readOnly: false }]) },
    ], nodes);
    expect(rows.map((r) => `${r.kind}:${r.part}:${r.server?.name ?? '-'}`)).toEqual(['pinned:db:lon-2', 'roaming:cache:-', 'throwaway:web:-', 'host:web:-']);
  });

  test('make durable names the one anonymous volume and keeps the rest', () => {
    const name = durableName('shop', 'web', '/app/.cache');
    expect(name).toBe('shop_web-app-cache');
    expect(withDurable([{ type: 'volume', target: '/app/.cache', readOnly: false }, { type: 'bind', source: '/etc/ssl', target: '/ssl', readOnly: true }], '/app/.cache', name)).toEqual([
      { type: 'volume', source: 'shop_web-app-cache', target: '/app/.cache', readOnly: false },
      { type: 'bind', source: '/etc/ssl', target: '/ssl', readOnly: true },
    ]);
  });
});
