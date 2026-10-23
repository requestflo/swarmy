import { describe, expect, test } from 'bun:test';
import type { InvService, NodeStatsSnapshot, NodeSummary, ServiceSummary } from '@swarmy/core';
import type { FleetServer } from '../use-fleet';
import { buildFleet, chipOf, fleetLinks, isNat, ringsOf, tileHeight } from './fleet-model';
import { serverStory } from './server-story';

const GB = 1024 ** 3;

const node = (id: string, o: Partial<NodeSummary> = {}): NodeSummary => ({
  id,
  name: id,
  hostname: `${id}.internal`,
  role: 'worker',
  status: 'online',
  engineVersion: null,
  os: null,
  arch: null,
  resources: { cpus: 4, memBytes: 16 * GB },
  agentVersion: null,
  agentCommit: null,
  agentUpdateAvailable: false,
  lastSeenAt: null,
  live: { cpuPercent: 30, memPercent: 40 },
  ...o,
});

const live = (o: Partial<NodeStatsSnapshot> = {}): NodeStatsSnapshot => ({
  nodeId: 'x',
  ts: 1,
  cpuPercent: 21.4,
  cpuCount: 4,
  memUsedBytes: 4 * GB,
  memTotalBytes: 16 * GB,
  netRxBytes: 0,
  netTxBytes: 0,
  fsUsedBytes: 81,
  fsTotalBytes: 100,
  ...o,
});

const server = (n: NodeSummary, l: NodeStatsSnapshot | null = null, diskPct: number | null = null): FleetServer => ({
  node: n,
  live: l,
  diskPct,
  containers: null,
  monthlyUsd: null,
});

const svc = (id: string, name: string, stackId: string | null, status: ServiceSummary['status'] = 'running'): ServiceSummary => ({
  id,
  name,
  image: 'img',
  status,
  replicas: { desired: 1, running: 1 },
  ingressEnabled: false,
  nodeId: null,
  stackId,
  updatedAt: '',
});

describe('fleet model', () => {
  test('rings: the live sample wins, the summary fills in, disk stays null without a number', () => {
    expect(ringsOf(server(node('a'), live(), 81))).toEqual({ cpu: 21, mem: 25, disk: 81 });
    expect(ringsOf(server(node('a')))).toEqual({ cpu: 30, mem: 40, disk: null });
    expect(ringsOf(server(node('a', { live: null })))).toEqual({ cpu: null, mem: null, disk: null });
  });

  test('NAT from the reachability label; the override wins', () => {
    expect(isNat({ 'swarmy.node.reachability': 'nat' })).toBe(true);
    expect(isNat({ 'swarmy.node.reachability': 'nat', 'swarmy.node.reachability.override': 'public' })).toBe(false);
    expect(isNat(undefined)).toBe(false);
  });

  test('chips: short names, app, status from the live inventory, swarmy’s own parts marked', () => {
    const inv = { id: 's1', name: 'storefront_web', stack: 'storefront', status: 'degraded', labels: {} } as unknown as InvService;
    expect(chipOf(svc('s1', 'storefront_web', 'storefront'), inv)).toMatchObject({ short: 'web', app: 'storefront', tone: 'warn', word: 'Needs you', system: false });
    const sys = { id: 's2', name: 'swarmy-garage', stack: 'swarmy-system', status: 'running', labels: {} } as unknown as InvService;
    expect(chipOf(svc('s2', 'swarmy-garage', null), sys).system).toBe(true);
    expect(chipOf(svc('s3', 'nats', 'data', 'stopped'), undefined)).toMatchObject({ short: 'nats', tone: 'idle', word: 'Stopped' });
  });

  test('groups by region with coordinates, mesh state and links between private-network servers', () => {
    const groups = buildFleet({
      servers: [server(node('a', { region: 'eu-west' })), server(node('b', { region: 'eu-west' })), server(node('c'))],
      coords: [{ region: 'eu-west', lat: 53, lng: -6 }],
      meshOn: true,
      peers: [
        { nodeId: 'a', meshIp: '100.92.0.1', status: 'CONNECTED' },
        { nodeId: 'b', meshIp: null, status: 'ENROLLED' },
      ],
      labelsOf: new Map([['c', { 'swarmy.node.reachability': 'nat' }]]),
      servicesByNode: new Map([['a', [svc('s1', 'web', 'storefront')]]]),
      inventory: undefined,
    });
    expect(groups.map((g) => [g.region, g.lat, g.servers.map((s) => s.server.node.id)])).toEqual([
      ['eu-west', 53, ['a', 'b']],
      [null, null, ['c']],
    ]);
    const [a, b] = groups[0]!.servers;
    expect(a!.mesh).toEqual({ state: 'connected', ip: '100.92.0.1' });
    expect(b!.mesh.state).toBe('joining');
    expect(b!.services).toBeUndefined();
    expect(groups[1]!.servers[0]!.nat).toBe(true);
    expect(fleetLinks(groups)).toEqual([{ a: 'a', b: 'b', ok: false }]);
  });

  test('tile height grows per chip, capped with a "more" row', () => {
    expect(tileHeight({ chips: 0, tech: false, coarse: false })).toBe(tileHeight({ chips: 1, tech: false, coarse: false }));
    expect(tileHeight({ chips: 9, tech: false, coarse: false })).toBe(tileHeight({ chips: 5, tech: false, coarse: false }));
    expect(tileHeight({ chips: 2, tech: true, coarse: false }) - tileHeight({ chips: 2, tech: false, coarse: false })).toBe(28);
  });
});

describe('serverStory', () => {
  const base = { rings: { cpu: 30, mem: 40, disk: 38 }, nat: false, mesh: 'connected' as const, yours: 3, diskHotPct: 80 };

  test('what it does and where, what runs there, room', () => {
    const n = node('a', { role: 'manager', ingress: true, region: 'eu-west', publicIp: '198.51.100.10' });
    expect(serverStory({ ...base, node: n })).toBe('Runs swarmy itself and serves your visitors in eu-west. 3 of your services run here. There’s plenty of room.');
  });

  test('the clause that matters: offline, emptying, disk, busy', () => {
    const n = node('a', { publicIp: '1.2.3.4' });
    expect(serverStory({ ...base, node: { ...n, status: 'offline' } })).toBe('Runs your apps. It stopped answering.');
    expect(serverStory({ ...base, node: { ...n, status: 'draining' }, yours: 1 })).toMatch(/1 of your services runs here\. It’s being emptied/);
    expect(serverStory({ ...base, node: n, rings: { cpu: 30, mem: 40, disk: 81 } })).toMatch(/Its disk is 81% full\.$/);
    expect(serverStory({ ...base, node: n, rings: { cpu: 30, mem: 88, disk: 40 }, yours: 0 })).toMatch(/None of your services run here yet\. It’s busy: memory at 88%\.$/);
  });

  test('how it is reached: behind NAT, or no public address', () => {
    const n = node('a', { publicIp: null });
    expect(serverStory({ ...base, node: n, nat: true, yours: undefined })).toMatch(/over the private network\.$/);
    expect(serverStory({ ...base, node: n, mesh: 'off', yours: undefined })).toMatch(/It has no public address\.$/);
  });
});
