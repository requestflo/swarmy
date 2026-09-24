import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';
import type { AppConfig } from './schema';

const cfg = (text: string): AppConfig => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};

/** Drop signatures/keys for golden comparisons (they are asserted separately). */
const strip = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (k, x) => (k === 'sig' || k === 'key' ? undefined : x)));

describe('toDesired', () => {
  it('fills every default for the minimal example (golden)', () => {
    expect(strip(toDesired(cfg(MINIMAL_EXAMPLE)))).toEqual({
      app: 'blog',
      stack: 'blog',
      environment: 'production',
      services: [
        {
          name: 'web',
          serviceName: 'blog_web',
          source: { kind: 'build', context: '.', dockerfile: 'Dockerfile', args: {}, watch: ['.'] },
          port: 3000,
          replicas: 1,
          env: { DATABASE_URL: '${{ db.url }}' },
          bindings: ['db.url'],
          secrets: [],
          volumes: [],
          placement: { regions: [], labels: {} },
          dependsOn: ['db'],
        },
      ],
      resources: [
        {
          name: 'db',
          type: 'postgres',
          version: 16,
          ha: 'single',
          replicas: 0,
          database: 'db',
          backups: { schedule: 'daily', keep: 7 },
        },
      ],
      routes: [
        { host: 'blog.example.com', path: '/', service: 'web', port: 3000, stripPath: false },
      ],
      jobs: [],
      connect: [],
      previews: { enabled: false, ttlSeconds: 259200, resources: 'isolated' },
    });
  });

  it('normalises the full example: shared build, presets, protections, jobs', () => {
    const d = toDesired(cfg(FULL_EXAMPLE));
    const web = d.services.find((s) => s.name === 'web');
    const worker = d.services.find((s) => s.name === 'worker');
    const admin = d.services.find((s) => s.name === 'admin');
    // web + worker declare identical build inputs → one build key.
    expect(
      web?.source.kind === 'build' &&
        worker?.source.kind === 'build' &&
        web.source.key === worker.source.key,
    ).toBe(true);
    expect(web?.cpu).toBe(0.5);
    expect(web?.memoryMb).toBe(512);
    expect(web?.env.NODE_ENV).toBe('production'); // shared env merged in
    expect(web?.healthcheck).toEqual({
      kind: 'http',
      path: '/healthz',
      port: 3000,
      intervalSeconds: 10,
    });
    expect(web?.dependsOn).toEqual(['cache', 'db', 'invoices', 'search']);
    expect(worker?.command).toEqual(['node', 'dist/worker.js']);
    expect(web?.release).toEqual(['sh', '-c', 'npm run migrate']);
    expect(worker?.release).toBeUndefined();
    expect(admin?.sleepAfterSeconds).toBe(900);
    expect(admin?.dependsOn).toEqual(['web']);
    expect(admin?.volumes).toEqual([
      { name: 'uploads', volumeName: 'orders_admin-uploads', target: '/data/uploads' },
    ]);
    expect(strip(d.routes)).toEqual([
      { host: 'admin.northwind.dev', path: '/', service: 'admin', port: 8080, stripPath: false },
      {
        host: 'api.northwind.dev',
        path: '/v1',
        service: 'web',
        port: 3000,
        stripPath: false,
        protection: {
          rateLimit: { requests: 100, windowSeconds: 60 },
          countryDeny: ['RU'],
          blockBots: true,
        },
      },
      { host: 'orders.northwind.dev', path: '/', service: 'web', port: 3000, stripPath: false },
    ]);
    expect(strip(d.jobs)).toEqual([
      {
        name: 'invoices',
        schedule: '0 2 * * *',
        service: 'worker',
        command: ['sh', '-c', 'npm run invoices'],
        timeoutSeconds: 1800,
        retries: 0,
        env: {},
      },
    ]);
    expect(d.resources.map((r) => `${r.type}:${r.name}`)).toEqual([
      'cache:cache',
      'postgres:db',
      'vector:embeddings',
      'bucket:invoices',
      'search:search',
    ]);
    expect(d.connect).toEqual(['billing']);
  });

  it('re-targets a preview: own stack, throwaway data, pr hosts, no cron, no links', () => {
    const d = toDesired(cfg(FULL_EXAMPLE), {
      preview: { pr: 42, baseDomain: 'preview.northwind.dev' },
    });
    expect(d.stack).toBe('orders-pr42');
    expect(d.preview).toEqual({ pr: 42 });
    expect(d.services.find((s) => s.name === 'web')?.serviceName).toBe('orders-pr42_web');
    expect(d.services.find((s) => s.name === 'web')?.replicas).toBe(1);
    expect(d.services.find((s) => s.name === 'web')?.sleepAfterSeconds).toBe(1800);
    const db = d.resources.find((r) => r.name === 'db');
    expect(
      db?.type === 'postgres' && { ha: db.ha, replicas: db.replicas, backups: db.backups },
    ).toEqual({ ha: 'single', replicas: 0, backups: null });
    expect(d.routes.map((r) => `${r.host}→${r.service}`)).toEqual([
      'pr-42-admin.preview.northwind.dev→admin',
      'pr-42.preview.northwind.dev→web',
    ]);
    expect(d.jobs).toEqual([]);
    expect(d.connect).toEqual([]);
  });

  it('shared-resource previews declare no resources of their own', () => {
    const text = MINIMAL_EXAMPLE + 'previews: { enabled: true, resources: shared }\n';
    const d = toDesired(cfg(text), { preview: { pr: 3, baseDomain: 'p.example.com' } });
    expect(d.resources).toEqual([]);
    expect(d.sharedResourcesFrom).toBe('blog');
  });

  it('signatures are stable across key order and change with meaning', () => {
    const a = toDesired(cfg(MINIMAL_EXAMPLE));
    const reordered = toDesired(
      cfg(
        'version: 1\napp: blog\nresources: { db: postgres }\nservices:\n  web:\n    env: { DATABASE_URL: "${{ db.url }}" }\n    domains: [blog.example.com]\n    port: 3000\n    build: .\n',
      ),
    );
    expect(reordered.services[0]?.sig).toBe(a.services[0]?.sig as string);
    expect(reordered.resources[0]?.sig).toBe(a.resources[0]?.sig as string);
    const bumped = toDesired(cfg(MINIMAL_EXAMPLE.replace('port: 3000', 'port: 3001')));
    expect(bumped.services[0]?.sig).not.toBe(a.services[0]?.sig as string);
  });
});
