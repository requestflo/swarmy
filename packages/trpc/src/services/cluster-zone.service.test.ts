import { afterEach, describe, expect, it } from 'bun:test';
import { bundleSignature } from '@swarmy/dns';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { autoAddressBase, reconcileAutoAddressesOrg } from './auto-address.service';
import { AUTO_ADDRESS_BASE_ENV, getAutoAddressBase, wildcardBaseFrom } from './auto-address-base.service';
import { delegationGlue, ensureClusterZone, getClusterZone, setClusterZone } from './cluster-zone.service';
import { buildDnsSnapshotBundle } from './dns-snapshot.service';
import { listZones } from './dns-zones.service';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

/** B2(b): the cluster zone — synthesis on the snapshot, the auto-address base, the registrar glue. */

const EDGE = '5.9.10.200';
const LAN = '10.0.0.9';

function svc(): SwarmServiceInfo {
  return {
    id: 'svc-1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
    createdAt: 0, updatedAt: 0, networks: [], env: [], secrets: [], configs: [],
    labels: { 'com.docker.stack.namespace': 'shop' },
    ports: [{ target: 3000, published: 3000, protocol: 'tcp' as const }],
  } as unknown as SwarmServiceInfo;
}

type Zone = { zone: string; settings?: object; advertisedNodeIds?: string[]; mode?: string; enabled?: boolean };

function ctxWith(zones: Zone[] = [], settings: Record<string, unknown> = {}, nodeIps: string[] = [EDGE, LAN]) {
  const labels = (ip: string) => ({ 'swarmy.node.public-ip': ip, 'swarmy.region': 'eu-west' });
  const ctx = {
    activeOrgId: 'org_1',
    db: {
      node: { findMany: async () => [{ id: 'n0' }] },
      auditLog: { create: async () => ({}) },
      statusPage: { findMany: async () => [] },
      inboundEndpoint: { findMany: async () => [] },
      emailDomain: { findMany: async () => [] },
      aiProviderConfig: { findUnique: async () => null },
    },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n0',
      nodesByRole: () => ['n0'],
      nodeInfoFor: (id: string) => ({ labels: labels(nodeIps[Number(id.slice(1))] ?? EDGE) }),
      nodeInventory: () => nodeIps.map((ip) => ({ labels: labels(ip) })),
      ingressStatusFor: () => undefined,
      latestContainers: () => [],
      liveInventory: () => ({ services: [svc()], containers: [] }),
      dispatch: async () => ({}),
    },
  } as unknown as OrgContext;
  useMemoryKv(ctx.hub);
  seedKv(ctx.hub, 'org_1', 'ingress', 'org_1', { driver: 'CADDY', enabled: true, settings: { domainChecks: { hosts: {} }, ...settings } });
  zones.forEach((z, i) =>
    seedKv(ctx.hub, 'org_1', 'dns-zone', `z${i}`, { enabled: true, mode: 'swarmy-ns', records: [], advertisedNodeIds: [], ttl: 30, apexToEdge: true, autoWww: true, ...z }),
  );
  return ctx;
}

const CLUSTER: Zone = { zone: 'apps.acme.com', settings: { clusterZone: true }, advertisedNodeIds: ['n0', 'n1'] };

afterEach(() => {
  delete process.env[AUTO_ADDRESS_BASE_ENV];
});

describe('the cluster zone is the auto-address base', () => {
  it('wins over the org setting and the env; sslip.io only when there is none', async () => {
    expect(wildcardBaseFrom({ autoAddressBase: 'ip.acme.net' }, { [AUTO_ADDRESS_BASE_ENV]: 'nip.io' }, 'Apps.Acme.com')).toBe('apps.acme.com');
    process.env[AUTO_ADDRESS_BASE_ENV] = 'nip.io';
    expect(await autoAddressBase(ctxWith([], { autoAddressBase: 'ip.acme.net' }))).toBe('5-9-10-200.ip.acme.net');
    expect(await autoAddressBase(ctxWith([CLUSTER], { autoAddressBase: 'ip.acme.net' }))).toBe('5-9-10-200.apps.acme.com');
    expect((await getAutoAddressBase(ctxWith([CLUSTER]))).effective).toBe('apps.acme.com');
    delete process.env[AUTO_ADDRESS_BASE_ENV];
    expect(await autoAddressBase(ctxWith([]))).toBe('5-9-10-200.sslip.io');
  });

  it('a zone flagged for app addresses still wins (shorter, steered names)', async () => {
    const both = ctxWith([CLUSTER, { zone: 'acme.com', settings: { autoAddresses: true } }]);
    expect(await autoAddressBase(both)).toBe('acme.com');
  });

  it('stamps <svc>-<stack>.<edge-ip>.<zone> through the DNS gate (it resolves only once delegated)', async () => {
    const ctx = ctxWith([CLUSTER]);
    const actions = await reconcileAutoAddressesOrg(ctx, Date.now());
    expect(actions.map((a) => a.host)).toEqual(['web-shop.5-9-10-200.apps.acme.com']);
    const doc = peekKv(ctx.hub as never, 'org_1', 'ingress', 'org_1') as { settings: { domainChecks: { hosts: object } } };
    expect(Object.keys(doc.settings.domainChecks.hosts)).toEqual(['web-shop.5-9-10-200.apps.acme.com']);
  });
});

describe('the snapshot pushed to swarmy-dns carries it', () => {
  it('only the cluster zone gets synth, with the public node addresses', async () => {
    const ctx = ctxWith([CLUSTER, { zone: 'acme.org' }]);
    const { bundle } = await buildDnsSnapshotBundle(ctx);
    const byZone = new Map(bundle.zones.map((z) => [z.zone, z]));
    expect(byZone.get('apps.acme.com')?.synth).toEqual({ ips: [EDGE] });
    expect(byZone.get('acme.org')?.synth).toBeUndefined();
    expect((await listZones(ctx)).map((z) => [z.zone, z.clusterZone])).toEqual([['acme.org', false], ['apps.acme.com', true]]);
  });

  it('a new server address changes the bundle signature, so the gated push goes out', async () => {
    const before = bundleSignature((await buildDnsSnapshotBundle(ctxWith([CLUSTER]))).bundle);
    const after = bundleSignature((await buildDnsSnapshotBundle(ctxWith([CLUSTER], {}, [EDGE, '41.76.108.20']))).bundle);
    expect(after).not.toBe(before);
  });
});

describe('getClusterZone / setClusterZone', () => {
  it('shows the glue, the base and its source', async () => {
    const view = await getClusterZone(ctxWith([CLUSTER], {}, [EDGE, '41.76.108.20']));
    expect(view).toMatchObject({ zone: 'apps.acme.com', addressBase: '5-9-10-200.apps.acme.com', source: 'cluster-zone', synthesized: ['41.76.108.20', EDGE] });
    expect(view.glue).toEqual([
      { name: 'apps.acme.com', type: 'NS', value: 'ns1.apps.acme.com' },
      { name: 'apps.acme.com', type: 'NS', value: 'ns2.apps.acme.com' },
      { name: 'ns1.apps.acme.com', type: 'A', value: EDGE },
      { name: 'ns2.apps.acme.com', type: 'A', value: '41.76.108.20' },
    ]);
    expect(await getClusterZone(ctxWith([]))).toMatchObject({ zone: null, source: 'public-convenience', glue: [] });
  });

  it('refuses a zone swarmy does not serve; turning it off needs no check', async () => {
    const ctx = ctxWith([{ zone: 'acme.org', mode: 'cloudflare' }, CLUSTER]);
    await expect(setClusterZone(ctx, 'z0', true)).rejects.toThrow("served by swarmy's nameservers");
    expect((await setClusterZone(ctx, 'z1', false)).zone).toBeNull();
  });

  it('delegationGlue skips glue for a nameserver with no address yet', () => {
    expect(delegationGlue('z.io', [{ fqdn: 'ns1.z.io', ip: '' }])).toEqual([{ name: 'z.io', type: 'NS', value: 'ns1.z.io' }]);
  });
});

describe('ensureClusterZone (installer --zone)', () => {
  it('creates the zone flagged, enabled, with geo-DNS on — once, never over an existing choice', async () => {
    const ctx = ctxWith([]);
    expect(await ensureClusterZone(ctx, 'org_1', 'Apps.Acme.com.')).toBe(true);
    expect(await ensureClusterZone(ctx, 'org_1', 'apps.acme.com')).toBe(false);
    expect((await getClusterZone(ctx)).zone).toBe('apps.acme.com');
    expect((peekKv(ctx.hub as never, 'org_1', 'geodns', 'org_1') as { enabled: boolean }).enabled).toBe(true);
    expect(await ensureClusterZone(ctxWith([CLUSTER]), 'org_1', 'other.acme.com')).toBe(false);
    await expect(ensureClusterZone(ctx, 'org_1', 'not a zone')).rejects.toThrow('not a zone name');
  });
});
