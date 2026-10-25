import { describe, expect, it } from 'bun:test';
import { EDGE_GEOIP_BUNDLED_PATH } from '@swarmy/ingress';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { getEdgeGeoip } from './edge-geoip.service';
import { setEdgeGeoip } from './ingress-setters';
import { previewConfig } from './ingress.service';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

const ROUTE = { host: 'shop.acme.com', port: 3000, tls: 'auto', protection: { countryDeny: ['KP'] } };

function svc(): SwarmServiceInfo {
  return {
    id: 'svc1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
    createdAt: 0, updatedAt: 0, networks: [], env: [], ports: [], secrets: [], configs: [],
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': JSON.stringify([ROUTE]) },
  };
}

const EDGE = 'swarmy-ingress-caddy';
/** A running edge task, so a settings write's one apply has somewhere to land. */
const TASK = { id: 'c1', name: `${EDGE}.1`, image: 'caddy', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: { 'com.docker.swarm.service.name': EDGE } };

function ctxWith(settings: Record<string, unknown> = {}): { ctx: OrgContext; audits: unknown[]; sent: string[] } {
  const audits: unknown[] = [];
  const sent: string[] = [];
  const db = {
    node: { findMany: async () => [{ id: 'm1' }] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async (a: unknown) => audits.push(a) },
  };
  const hub = {
    isOnline: () => true,
    managerNode: () => 'm1',
    nodeInfoFor: () => ({ labels: {} }),
    liveInventory: () => ({ services: [svc()], containers: [] }),
    latestContainers: () => [TASK],
    dispatch: async (_n: string, cmd: string) => void sent.push(cmd),
  };
  useMemoryKv(hub as unknown as OrgContext['hub']);
  seedKv(hub as never, 'org_1', 'ingress', 'org_1', { driver: 'CADDY', enabled: true, settings });
  const ctx = { db, hub, activeOrgId: 'org_1', session: { user: { id: 'u1' } } } as unknown as OrgContext;
  return { ctx, audits, sent };
}

async function caddyText(ctx: OrgContext): Promise<string> {
  const pv = await previewConfig(ctx, 'caddy');
  return pv.localReload?.file?.contents ?? pv.files.map((f) => f.contents).join('\n');
}

describe('edge country database', () => {
  it('by default the edge enforces country rules with the bundled DB-IP Country Lite', async () => {
    const { ctx } = ctxWith();
    expect(await getEdgeGeoip(ctx)).toMatchObject({ mode: 'bundled', effectivePath: EDGE_GEOIP_BUNDLED_PATH, source: 'bundled' });
    expect(await caddyText(ctx)).toContain(`db_path ${EDGE_GEOIP_BUNDLED_PATH}`);
  });

  it('a stock Caddy image cannot carry it: rules saved, not enforced', async () => {
    const { ctx } = ctxWith({ controllerImage: 'caddy:2-alpine' });
    expect((await getEdgeGeoip(ctx)).effectivePath).toBeNull();
    expect(await caddyText(ctx)).not.toContain('maxmind_geolocation');
  });

  it('setting a file path persists in swarm-kv, is audited, re-renders once, and wins over the bundle', async () => {
    const { ctx, audits, sent } = ctxWith();
    const v = await setEdgeGeoip(ctx, { mode: 'file', path: '/geoip/country.mmdb' });
    expect(v).toMatchObject({ mode: 'file', path: '/geoip/country.mmdb', effectivePath: '/geoip/country.mmdb' });
    expect(sent.filter((c) => c === 'applyIngress')).toHaveLength(1);
    expect(sent.filter((c) => c === 'service.deploy' || c === 'service.remove')).toEqual([]); // a render, never a redeploy
    expect(audits).toHaveLength(1);
    const doc = peekKv(ctx.hub as never, 'org_1', 'ingress', 'org_1') as { settings: { geoip: unknown } };
    expect(doc.settings.geoip).toEqual({ mode: 'file', path: '/geoip/country.mmdb' });
    expect(await caddyText(ctx)).toContain('db_path /geoip/country.mmdb');
  });

  it('off stops enforcement; an old raw extraConfig path shows up as the file mode until changed', async () => {
    const legacy = ctxWith({ globalOptions: { extraConfig: { geoipMmdbPath: '/data/geo.mmdb' } } });
    expect(await getEdgeGeoip(legacy.ctx)).toMatchObject({ mode: 'file', path: '/data/geo.mmdb', source: 'file' });
    await setEdgeGeoip(legacy.ctx, { mode: 'off', path: '/ignored.mmdb' });
    expect(await getEdgeGeoip(legacy.ctx)).toMatchObject({ mode: 'off', path: null, effectivePath: null });
    expect(await caddyText(legacy.ctx)).not.toContain('maxmind_geolocation');
  });

  it('a file mode without a path is refused and nothing changes', async () => {
    const { ctx, audits, sent } = ctxWith();
    await expect(setEdgeGeoip(ctx, { mode: 'file' })).rejects.toThrow(/file path is required/);
    expect(await getEdgeGeoip(ctx)).toMatchObject({ mode: 'bundled' });
    expect(audits).toEqual([]);
    expect(sent).toEqual([]);
  });
});
