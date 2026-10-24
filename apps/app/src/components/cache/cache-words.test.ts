import { describe, expect, test } from 'bun:test';
import type { NodeSummary } from '@swarmy/core';
import { cacheDiagram, ifDies, sentinelLine, type CacheView } from './cache-words';

const node = (id: string): NodeSummary => ({ id, name: id, region: null, status: 'online' }) as NodeSummary;

const view = (over: Partial<CacheView> = {}): CacheView => ({
  stack: 'shop',
  name: 'main',
  engine: 'valkey',
  topology: 'sentinel',
  memoryMb: 512,
  declaredReplicas: 2,
  evictionPolicy: 'allkeys-lru',
  persistence: 'aof',
  policyApplied: true,
  primary: { service: 'shop_main-cache', status: 'running' },
  replicas: { desired: 2, running: 2 },
  sentinels: { desired: 3, running: 3 },
  host: 'shop_main-cache',
  port: 6379,
  passwordSecret: 'swarmy-cache-shop_main-password',
  members: [
    { service: 'shop_main-cache', role: 'primary', status: 'running', desired: 1, running: 1 },
    { service: 'shop_main-cache-replica', role: 'replica', status: 'running', desired: 2, running: 2 },
    { service: 'shop_main-cache-sentinel', role: 'sentinel', status: 'running', desired: 3, running: 3 },
  ],
  stats: null,
  attachments: [{ service: 'web', envVar: 'REDIS_URL' }, { service: 'api', envVar: 'REDIS_URL' }],
  purpose: 'cache',
  ...over,
});

const place = new Map([
  ['shop_main-cache', [node('wkr-2')]],
  ['shop_main-cache-replica', [node('wkr-1'), node('mgr-2')]],
  ['shop_main-cache-sentinel', [node('mgr-1'), node('mgr-2'), node('wkr-1')]],
]);

describe('ifDies', () => {
  test('sentinel: the vote, the quorum and where the standby copies are', () => {
    const d = ifDies(view(), place);
    expect(d.server).toBe('wkr-2');
    expect(d.text).toBe('3 sentinels on mgr-1, mgr-2 and wkr-1 vote (2 of 3 needed) and switch over to a standby copy on wkr-1 or mgr-2.');
    expect(d.tech).toContain('only sentinel-aware clients');
  });
  test('too few sentinels running to vote', () => {
    expect(ifDies(view({ sentinels: { desired: 3, running: 1 } }), place)).toMatchObject({ tone: 'bad' });
  });
  test('replica: a copy, but nothing switches over by itself', () => {
    const d = ifDies(view({ topology: 'replica' }), place);
    expect(d.text).toBe('The standby copies on wkr-1 and mgr-2 keep the data, but nothing switches over by itself, so web and api can’t reach the cache until wkr-2 is back.');
  });
  test('single: pinned to its server’s disk', () => {
    const d = ifDies(view({ topology: 'single', replicas: { desired: 0, running: 0 } }), place);
    expect(d.text).toBe('web and api lose the cache until wkr-2 is back. It stays on wkr-2, because its data lives on that server’s disk.');
    expect(d.tech).toContain('shop_main-cache-data');
  });
});

describe('the diagram', () => {
  test('apps → main copy → one box per standby server', () => {
    const { columns, links } = cacheDiagram(view(), place, false);
    expect(columns.map((c) => c.map((b) => b.title))).toEqual([['web', 'api'], ['wkr-2'], ['wkr-1', 'mgr-2']]);
    expect(links.filter((l) => l.label === 'REDIS_URL')).toHaveLength(2);
    expect(sentinelLine(view(), place)).toBe('3 of 3 sentinels running on mgr-1, mgr-2 and wkr-1, watching the main copy');
  });
});
