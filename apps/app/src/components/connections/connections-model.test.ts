import { describe, expect, test } from 'bun:test';
import {
  connectableApps,
  dataWords,
  envVarsFor,
  groupResources,
  hostPort,
  linkAuditLine,
  linkErrorWords,
  listWords,
  peerAddresses,
  privateWords,
  shortOf,
  typedName,
} from './connections-model';
import type { ResourceEndpoint, ServiceEndpoints } from './types';

const web: ServiceEndpoints = {
  service: 'storefront_web',
  short: 'web',
  ports: [3000],
  names: [
    { host: 'web', port: 3000, scope: 'app' },
    { host: 'storefront_web', port: 3000, scope: 'app' },
    { host: 'tasks.web', port: 3000, scope: 'app' },
  ],
};
const worker: ServiceEndpoints = { service: 'storefront_worker', short: 'worker', ports: [], names: [{ host: 'storefront_worker', scope: 'app' }] };

const res = (r: Partial<ResourceEndpoint>): ResourceEndpoint => ({ kind: 'postgres', name: 'db', host: 'h', port: 5432, attached: [], ...r });

describe('connections model', () => {
  test('addresses and names', () => {
    expect(hostPort('web', 3000)).toBe('web:3000');
    expect(hostPort('worker')).toBe('worker');
    expect(shortOf('storefront', 'storefront_api')).toBe('api');
    expect(shortOf('storefront', 'api')).toBe('api');
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  test('the typed name is the short alias, else the swarm name', () => {
    expect(typedName(web)?.host).toBe('web');
    expect(typedName(worker)?.host).toBe('storefront_worker');
  });

  test('a connected app types <service>.<app>, with the port only when there is one', () => {
    expect(peerAddresses({ stack: 'storefront', connectedApps: [], services: [web, worker], resources: [] })).toEqual([
      'web.storefront:3000',
      'worker.storefront',
    ]);
  });

  test('platform stacks and empty apps are not connectable', () => {
    expect(
      connectableApps([
        { name: 'storefront', serviceCount: 4 },
        { name: 'swarmy-system', serviceCount: 4 },
        { name: 'draft', serviceCount: 0 },
        { name: 'blog', serviceCount: 2 },
      ]),
    ).toEqual(['storefront', 'blog']);
  });

  test('members fold into one resource, primary first, kinds in order', () => {
    const groups = groupResources([
      res({ kind: 'object-storage', name: 'media', host: 'swarmy-garage', port: 3900, attached: ['storefront_api'] }),
      res({ kind: 'cache', name: 'main', host: 'c-sentinel', port: 26379, role: 'sentinel' }),
      res({ kind: 'cache', name: 'main', host: 'c', port: 6379, role: 'primary', attached: ['storefront_web'] }),
      res({ name: 'checkout', host: 'p-replica', role: 'replica', attached: ['storefront_api'] }),
      res({ name: 'checkout', host: 'p', role: 'primary', attached: ['storefront_checkout', 'storefront_api'] }),
    ]);
    expect(groups.map((g) => `${g.kind}:${g.main.host}:${g.others.length}`)).toEqual(['postgres:p:1', 'cache:c:1', 'object-storage:swarmy-garage:0']);
    expect(groups[0]?.attached).toEqual(['storefront_api', 'storefront_checkout']);
    expect(dataWords(groups)).toBe('Postgres checkout, cache main and bucket media');
  });

  test('env vars: the wiring defaults, and per-attachment names for the rest', () => {
    const [pg, cache, bucket] = groupResources([
      res({ name: 'checkout' }),
      res({ kind: 'cache', name: 'main' }),
      res({ kind: 'object-storage', name: 'media' }),
    ]);
    expect(envVarsFor(pg!, {})).toEqual(['DATABASE_URL']);
    expect(envVarsFor(cache!, { 'cache:main': ['REDIS_URL'] })).toEqual(['REDIS_URL']);
    expect(envVarsFor(cache!, {})).toEqual([]);
    expect(envVarsFor(bucket!, {})).toEqual(['S3_ENDPOINT']);
  });

  test('what stays private, in words', () => {
    const [pg, cache] = groupResources([res({ name: 'checkout' }), res({ kind: 'cache', name: 'main' })]);
    expect(privateWords('storefront', [pg!, cache!], 'data', [pg!])).toBe(
      'Postgres checkout and cache main stay private to storefront; Postgres checkout to data.',
    );
    expect(privateWords('storefront', [pg!], 'blog', [])).toBe('Postgres checkout stays private to storefront.');
    expect(privateWords('storefront', [], 'blog', [cache!])).toBe('Cache main stays private to blog.');
    expect(privateWords('a', [], 'b', [])).toBe('Neither app has a managed database, cache or bucket.');
  });

  test('a policy deny names the permission it needs', () => {
    expect(linkErrorWords({ message: 'denied', data: { swarmyCode: 'POLICY_DENIED' } }, 'storefront', 'data')).toBe(
      'You need deploy permission on both storefront and data.',
    );
    expect(linkErrorWords({ message: 'stack not found' }, 'a', 'b')).toBe('stack not found');
  });

  test('the audit line is the newest link row naming the app', () => {
    const rows = [
      { ts: '2026-10-23T15:04:00Z', actorLabel: 'Ava Chen', action: 'stack.deploy', targetId: 'storefront' },
      { ts: '2026-10-23T15:03:00Z', actorLabel: 'Ava Chen', action: 'stack.link.add', targetId: 'data<->platform' },
      { ts: '2026-10-23T15:02:00Z', actorLabel: 'Demo Pilot', action: 'stack.link.remove', targetId: 'platform<->storefront' },
    ];
    expect(linkAuditLine(rows, 'storefront', () => '15:02')).toBe('stack.link.remove · Demo Pilot · 15:02 · platform ↔ storefront');
    expect(linkAuditLine(rows, 'blog')).toBeNull();
  });
});
