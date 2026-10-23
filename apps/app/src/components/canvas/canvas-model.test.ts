import { describe, expect, test } from 'bun:test';
import type { Inventory, InvService } from '@swarmy/core';
import type { StackEndpoints } from '@/components/connections/types';
import { buildGraph } from './build-graph';
import { hideManagedMembers, withExtras } from './canvas-extras';
import { domainSpec, rateWords, serviceMetrics } from './canvas-signals';
import { dataNodes } from './data-nodes';

const svc = (id: string, name: string, labels: Record<string, string> = {}, env: string[] = []): InvService => ({
  id,
  name,
  image: 'img',
  stack: 'shop',
  mode: 'replicated',
  replicas: { desired: 1, running: 1 },
  status: 'running',
  scaleToZero: false,
  labels,
  networks: [],
  env,
  ports: [],
  containers: [],
});

const endpoints: StackEndpoints = {
  stack: 'shop',
  connectedApps: [],
  services: [],
  resources: [
    { kind: 'postgres', name: 'db', host: 'shop_db-primary', port: 5432, role: 'primary', attached: ['shop_api'] },
    { kind: 'postgres', name: 'db', host: 'shop_db-replica', port: 5432, role: 'replica', attached: ['shop_api'] },
    { kind: 'cache', name: 'main', host: 'shop_main-cache', port: 6379, role: 'primary', attached: [] },
    { kind: 'object-storage', name: 'media', host: 'swarmy-garage', port: 3900, attached: ['shop_web'] },
  ],
};

describe('dataNodes', () => {
  test('one node per store, members folded, attachments as short names', () => {
    const nodes = dataNodes(endpoints, {
      cache: [{ name: 'main', engine: 'valkey', memoryMb: 512, host: 'shop_main-cache', port: 6379, passwordSecret: 'pw', primary: { service: 'x', status: 'running' }, stats: { hitRatePct: 97.4 } } as never],
      buckets: { endpoint: 'http://swarmy-garage:3900', region: 'garage', buckets: [{ id: 'b1', name: 'media', usageBytes: 2048, objects: 12_400 }] },
    });
    expect(nodes.map((n) => n.id)).toEqual(['data:postgres:db', 'data:cache:main', 'data:object-storage:media']);
    const [db, cache, media] = nodes;
    expect(db!.attached).toEqual(['api']);
    expect(db!.env[1]!.value).toContain('shop_db-replica');
    expect(db!.metric).toBeNull();
    expect(cache!.sub).toBe('cache · 512 MB');
    expect(cache!.tech).toBe('valkey');
    expect(cache!.metric).toBe('hit 97%');
    expect(cache!.tone).toBe('ok');
    expect(cache!.env.map((l) => `${l.key}=${l.value}`)).toEqual(['REDIS_URL=redis://shop_main-cache:6379', 'REDIS_PASSWORD_FILE=/run/secrets/pw']);
    expect(media!.bucketId).toBe('b1');
    expect(media!.metric).toBe('12k files');
  });
});

describe('signals', () => {
  test('rate words', () => {
    expect(rateWords(2280)).toBe('38 req/s');
    expect(rateWords(118)).toBe('2.0 req/s');
    expect(rateWords(12)).toBe('12/min');
    expect(rateWords(0.4)).toBe('<1/min');
  });

  test('a part matches its OTel name, swarm name or short name', () => {
    const m = serviceMetrics('shop', [svc('1', 'shop_web', {}, ['OTEL_SERVICE_NAME=shop-web']), svc('2', 'shop_api'), svc('3', 'shop_x')], [
      { id: 'shop-web', callsPerMin: 120, errorRate: 0.004, p95Ms: 240.4, degraded: false },
      { id: 'api', callsPerMin: 12, errorRate: 0, p95Ms: 80, degraded: false },
    ]);
    expect(m.get('web')).toEqual({ rate: '2.0 req/s', tech: 'p95 240 ms · 0.4% errors' });
    expect(m.get('api')?.rate).toBe('12/min');
    expect(m.has('x')).toBe(false);
  });

  test('the front door leads with a served HTTPS address', () => {
    const d = domainSpec(
      [
        { host: 'a.dev', serviceId: '1', serving: false, tls: 'auto' },
        { host: 'shop.dev', serviceId: '1', serving: true, tls: 'auto' },
        { host: 'api.dev', serviceId: '2', serving: true, tls: 'off' },
      ],
      { app: 'shop', requestsPerMin: 2280, errors5xxPerMin: 0, errorShare: 0, hosts: [] },
    );
    expect(d).toEqual({ host: 'shop.dev', more: 2, https: true, rate: '38 req/s', targets: ['1', '2'] });
    expect(domainSpec([], undefined)).toBeNull();
  });
});

describe('withExtras', () => {
  test('members hide; data nodes link from their parts; the door links to its targets', () => {
    const inv: Inventory = {
      projects: [{ name: 'shop', serviceIds: ['w', 'a', 'p'] }],
      services: [svc('w', 'shop_web'), svc('a', 'shop_api'), svc('p', 'shop_db-primary', { 'swarmy.db.cluster': 'db', 'swarmy.db.engine': 'postgres' })],
      edges: [{ from: 'a', to: 'p', kind: 'depends' }],
    };
    const visible = hideManagedMembers(inv);
    expect(visible.services.map((s) => s.id)).toEqual(['w', 'a']);
    expect(visible.edges).toEqual([]);
    const g = withExtras(buildGraph(visible), {
      stack: 'shop',
      data: dataNodes(endpoints, {}),
      domain: { host: 'shop.dev', more: 0, https: true, rate: null, targets: ['w'] },
      metrics: new Map([['api', { rate: '12/min', tech: 't' }]]),
    });
    expect(g.nodes.filter((n) => n.type === 'data')).toHaveLength(3);
    expect(g.edges.map((e) => e.id).sort()).toEqual(['attach:a->data:postgres:db', 'attach:w->data:object-storage:media', 'door:w']);
    const api = g.nodes.find((n) => n.id === 'a');
    expect((api?.data as { metric?: unknown }).metric).toEqual({ rate: '12/min', tech: 't' });
  });
});
