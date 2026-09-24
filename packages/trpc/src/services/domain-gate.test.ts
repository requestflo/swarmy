import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { parseDomainId, domainId, previewConfig } from './ingress.service';
import { hostPostures, hostsIntroducedByDeploy, registerDeployRoutes, toStatusView } from './domain-verify.service';

/**
 * The custom-domain DNS gate end to end through the controller's config
 * loader: a registered-but-unverified host is withheld from the render (so
 * Caddy never orders a certificate for it), a verified one is served, and a
 * www toggle expands into a redirect site.
 */

function svc(labels: Record<string, string>): SwarmServiceInfo {
  return {
    id: 'svc1',
    name: 'shop_web',
    image: 'web:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', ...labels },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  };
}

function ctxWith(routes: object[], domainChecks: unknown): OrgContext {
  const row = { driver: 'CADDY', enabled: true, settings: { domainChecks }, updatedAt: new Date(0) };
  const db = {
    observabilityConfig: { findUnique: async () => null },
    ingressConfig: { upsert: async () => row, findUnique: async () => row },
    node: { findMany: async () => [] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    storageCluster: { findUnique: async () => null },
    bucketAccess: { findMany: async () => [], count: async () => 0 },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    nodeInfoFor: () => ({ labels: {} }),
    liveInventory: () => ({ services: [svc({ 'swarmy.ingress.routes': JSON.stringify(routes) })], containers: [] }),
    latestContainers: () => [],
  };
  return { db, hub, activeOrgId: 'org_1' } as unknown as OrgContext;
}

/** The Caddyfile the edge would load (in-task delivery → localReload.file). */
async function caddyText(ctx: OrgContext): Promise<string> {
  const pv = await previewConfig(ctx, 'caddy');
  return pv.localReload?.file?.contents ?? pv.files.map((f) => f.contents).join('\n');
}

const rec = (host: string, extra: object = {}) => ({ host, addedAt: 1, gated: true, ...extra });

describe('DNS gate in the rendered config', () => {
  it('withholds a registered host until DNS verifies; serves verified + unregistered hosts', async () => {
    const ctx = ctxWith(
      [
        { host: 'new.acme.com', port: 3000, tls: 'auto' },
        { host: 'live.acme.com', port: 3000, tls: 'auto' },
        { host: 'legacy.acme.com', port: 3000, tls: 'auto' },
      ],
      { hosts: { 'new.acme.com': rec('new.acme.com'), 'live.acme.com': rec('live.acme.com', { verifiedAt: 5 }) } },
    );
    const out = await caddyText(ctx);
    expect(out).not.toContain('new.acme.com {');
    expect(out).toContain('live.acme.com {');
    expect(out).toContain('legacy.acme.com {');
  });

  it('a www toggle renders the canonical site + a 308 redirect, gated per host', async () => {
    const routes = [{ host: 'acme.com', port: 3000, tls: 'auto', www: 'redirect-www-to-apex' }];
    const text = await caddyText(ctxWith(routes, { hosts: {} }));
    expect(text).toContain('acme.com {');
    expect(text).toContain('www.acme.com {\n  # swarmy www redirect\n  redir https://acme.com{uri} 308\n}');
    // Apex verified, www still waiting for its record: no redirect site yet.
    const waiting = await caddyText(ctxWith(routes, { hosts: { 'www.acme.com': rec('www.acme.com') } }));
    expect(waiting).not.toContain('swarmy www redirect');
  });
});

describe('domain ids', () => {
  it('round-trip root and path routes', () => {
    expect(domainId('svc1', 'acme.com', null)).toBe('svc1:acme.com');
    expect(domainId('svc1', 'acme.com', '/')).toBe('svc1:acme.com');
    expect(domainId('svc1', 'acme.com', '/api')).toBe('svc1:acme.com/api');
    expect(parseDomainId('svc1:acme.com/api')).toEqual({ serviceId: 'svc1', host: 'acme.com', path: '/api' });
    expect(parseDomainId('svc1:acme.com')).toEqual({ serviceId: 'svc1', host: 'acme.com', path: null });
  });
});

describe('hostPostures / toStatusView', () => {
  it('folds routes per host, adds companions, marks private + tunnel', () => {
    expect(
      hostPostures(
        [
          { host: 'Acme.com', tls: 'auto', www: 'serve-both' },
          { host: 'acme.com', tls: 'manual' },
          { host: 'nas.lan', tls: 'auto' },
        ],
        'CADDY',
      ),
    ).toEqual([
      { host: 'acme.com', tls: 'custom', private: false, tunnel: false },
      { host: 'nas.lan', tls: 'auto', private: true, tunnel: false },
      { host: 'www.acme.com', tls: 'auto', private: false, tunnel: false },
    ]);
    expect(hostPostures([{ host: 'a.com', tls: 'auto' }], 'CLOUDFLARE_TUNNEL')[0]!.tunnel).toBe(true);
  });

  it('projects a waiting record', () => {
    const v = toStatusView(
      'a.com',
      { host: 'a.com', addedAt: 0, gated: true, lastCheckedAt: 1000, nextCheckAt: 31_000, dns: { ok: false, reason: 'No DNS record for a.com yet.', warnings: [], a: [], aaaa: [], cname: [], matched: [] } },
      { host: 'a.com', tls: 'auto', private: false, tunnel: false },
      2000,
    );
    expect(v).toMatchObject({
      state: 'waiting_dns',
      reason: 'No DNS record for a.com yet.',
      gated: true,
      lastCheckedAt: '1970-01-01T00:00:01.000Z',
      certificate: null,
    });
  });
});

describe('deploy-path domain gate', () => {
  const lbl = (routes: object[]) => ({ 'swarmy.ingress.routes': JSON.stringify(routes) });

  it('registers only hosts no live route serves (companions included)', () => {
    const { routes, liveHosts } = hostsIntroducedByDeploy(
      [
        lbl([
          { host: 'live.acme.com', port: 80, tls: 'auto' },
          { host: 'New.acme.com', port: 80, tls: 'auto' },
          { host: 'acme.com', port: 80, tls: 'auto', www: 'redirect-www-to-apex' },
        ]),
        undefined,
        {},
      ],
      [
        { host: 'live.acme.com', tls: 'auto' },
        { host: 'acme.com', tls: 'auto' },
      ],
    );
    // live.acme.com stays observed-only; the new www companion of a live apex is fresh.
    expect(routes.map((r) => r.host)).toEqual(['New.acme.com', 'acme.com']);
    expect([...liveHosts].sort()).toEqual(['acme.com', 'live.acme.com']);
  });

  it('a compose deploy declaring a new host writes a GATED record before the spec lands', async () => {
    const writes: string[] = [];
    const row = { driver: 'CADDY', enabled: true, settings: { domainChecks: { hosts: {} } } };
    const db = {
      ingressConfig: {
        findUnique: async () => row,
        update: async (args: { data: { settings: { domainChecks: { hosts: unknown } } } }) => {
          writes.push(JSON.stringify(args.data.settings.domainChecks.hosts));
          return row;
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const ctx = {
      activeOrgId: 'org_1',
      db,
      hub: {
        liveInventory: () => ({ services: [svc(lbl([{ host: 'live.acme.com', port: 80, tls: 'auto' }]))], containers: [] }),
      },
    } as unknown as OrgContext;
    const hosts = await registerDeployRoutes(ctx, [
      { labels: lbl([{ host: 'shop.acme.com', port: 80, tls: 'auto' }, { host: 'live.acme.com', port: 80, tls: 'auto' }]) },
      { labels: { foo: 'bar' } },
    ]);
    expect(hosts).toEqual(['shop.acme.com']);
    expect(writes).toHaveLength(1);
    const upserts = JSON.parse(writes[0]!) as Record<string, { gated: boolean }>;
    expect(Object.keys(upserts)).toEqual(['shop.acme.com']);
    expect(upserts['shop.acme.com']!.gated).toBe(true);
  });

  it('a redeploy of already-routed hosts writes nothing', async () => {
    const ctx = {
      activeOrgId: 'org_1',
      db: { $transaction: async () => { throw new Error('must not write'); } },
      hub: { liveInventory: () => ({ services: [svc(lbl([{ host: 'a.com', port: 80, tls: 'auto' }]))], containers: [] }) },
    } as unknown as OrgContext;
    expect(await registerDeployRoutes(ctx, [{ labels: lbl([{ host: 'a.com', port: 80, tls: 'auto' }]) }])).toEqual([]);
  });
});
