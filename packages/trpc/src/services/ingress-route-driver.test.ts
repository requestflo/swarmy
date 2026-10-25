import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { listDomains, previewConfig } from './ingress.service';
import { hostPostures, targetFor } from './domain-verify.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

/**
 * The per-route driver override (`driver` on a `swarmy.ingress.routes` entry)
 * and the declared mode (`swarmy.expose`) end to end through the controller's
 * config loader + the domain checks: a tunnel route leaves the public edge,
 * skips the ACME gate and is checked against the tunnel's CNAME.
 */

function svc(name: string, labels: Record<string, string>): SwarmServiceInfo {
  return {
    id: name,
    name,
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

const routes = (r: object[]) => ({ 'swarmy.ingress.routes': JSON.stringify(r) });

function ctxWith(services: SwarmServiceInfo[]): OrgContext {
  const db = {
    node: { findMany: async () => [] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    nodeInfoFor: () => ({ labels: {} }),
    liveInventory: () => ({ services, containers: [] }),
    latestContainers: () => [],
  };
  useMemoryKv(hub as unknown as OrgContext['hub']);
  seedKv(hub as never, 'org_1', 'ingress', 'org_1', { driver: 'CADDY', enabled: true, settings: {} });
  return { db, hub, activeOrgId: 'org_1' } as unknown as OrgContext;
}

async function caddyText(ctx: OrgContext): Promise<string> {
  const pv = await previewConfig(ctx, 'caddy');
  return pv.localReload?.file?.contents ?? pv.files.map((f) => f.contents).join('\n');
}

describe('render honours route.driver and swarmy.expose', () => {
  it('tunnel / none overrides and private services leave the public edge; legacy drivers stay on it', async () => {
    const ctx = ctxWith([
      svc('shop_web', routes([
        { host: 'shop.acme.com', port: 3000, tls: 'auto' },
        { host: 'admin.acme.com', port: 3000, tls: 'auto', driver: 'cloudflared' },
        { host: 'byo.acme.com', port: 3000, tls: 'auto', driver: 'none' },
        { host: 'old.acme.com', port: 3000, tls: 'auto', driver: 'traefik' },
      ])),
      svc('shop_db', { ...routes([{ host: 'db.acme.com', port: 5432, tls: 'auto' }]), 'swarmy.expose': 'private' }),
    ]);
    const out = await caddyText(ctx);
    expect(out).toContain('shop.acme.com {');
    expect(out).toContain('old.acme.com {');
    expect(out).not.toContain('admin.acme.com');
    expect(out).not.toContain('byo.acme.com');
    expect(out).not.toContain('db.acme.com');
  });

  it('listed domains carry the route driver and the declared exposure the dashboard picker reads', async () => {
    const ctx = ctxWith([
      svc('shop_web', routes([{ host: 'admin.acme.com', port: 3000, tls: 'auto', driver: 'none' }])),
      svc('shop_db', { ...routes([{ host: 'db.acme.com', port: 5432, tls: 'auto' }]), 'swarmy.expose': 'tunnel' }),
    ]);
    const rows = Object.fromEntries((await listDomains(ctx)).map((d) => [d.host, [d.ingressDriver, d.expose]]));
    expect(rows).toEqual({ 'admin.acme.com': ['none', null], 'db.acme.com': [null, 'tunnel'] });
  });
});

describe('domain checks follow the route onto the tunnel', () => {
  it('a host only on the tunnel skips the ACME gate; one with any edge route keeps it', () => {
    const p = hostPostures(
      [
        { host: 'admin.acme.com', tls: 'auto', driver: 'cloudflared' },
        { host: 'tunnel.acme.com', tls: 'auto', tunnel: true },
        { host: 'mixed.acme.com', tls: 'auto', driver: 'cloudflared' },
        { host: 'mixed.acme.com', tls: 'auto' },
        { host: 'old.acme.com', tls: 'auto', driver: 'traefik' },
      ],
      'CADDY',
    );
    expect(Object.fromEntries(p.map((x) => [x.host, x.tunnel]))).toEqual({
      'admin.acme.com': true,
      'mixed.acme.com': false,
      'old.acme.com': false,
      'tunnel.acme.com': true,
    });
  });

  it('a tunnel host on a Caddy org is checked against the tunnel CNAME, edge hosts against the IPs', () => {
    const expected = { ips: ['203.0.113.10'], tunnelCname: null, cnameTarget: 'swarmy.acme.com', tunnelSideCname: 't1.cfargotunnel.com' };
    const tunnel = { host: 'a.acme.com', tls: 'auto' as const, private: false, tunnel: true };
    expect(targetFor(expected, tunnel)).toEqual({ ips: [], tunnelCname: 't1.cfargotunnel.com', cnameTarget: null });
    expect(targetFor(expected, { ...tunnel, tunnel: false })).toBe(expected);
    expect(targetFor({ ...expected, tunnelSideCname: null }, tunnel).ips).toEqual(['203.0.113.10']);
  });
});
