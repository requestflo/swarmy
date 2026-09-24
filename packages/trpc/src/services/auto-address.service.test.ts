import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { autoAddressBase, reconcileAutoAddressesOrg } from './auto-address.service';

/**
 * Automatic app addresses on the org's OWN zone (swarmy-dns) with the
 * sslip.io fallback — and the DNS gate for own-zone names.
 */
function svc(labels: Record<string, string>, published = true): SwarmServiceInfo {
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
    ports: published ? [{ target: 3000, published: 3000, protocol: 'tcp', mode: 'ingress' }] : [],
    secrets: [],
    configs: [],
  } as SwarmServiceInfo;
}

function ctxWith(opts: { zones?: Array<{ zone: string; settings?: object }>; labels?: Record<string, string> }) {
  const dispatched: Array<{ cmd: string; payload: { add?: Record<string, string> } }> = [];
  const gated: string[] = [];
  const row = { driver: 'CADDY', enabled: true, settings: { domainChecks: { hosts: {} } } };
  const ctx = {
    activeOrgId: 'org_1',
    db: {
      ingressConfig: { findUnique: async () => row },
      node: { findMany: async () => [{ id: 'n1' }] },
      dnsZone: {
        findMany: async () => (opts.zones ?? []).map((z) => ({ ...z, enabled: true, mode: 'swarmy-ns' })),
      },
      auditLog: { create: async () => ({}) },
      $executeRaw: async (_s: TemplateStringsArray, ...vals: unknown[]) => {
        gated.push(...Object.keys(JSON.parse(String(vals[0]))));
        return 1;
      },
    },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n1',
      nodesByRole: () => ['n1'],
      nodeInfoFor: () => ({ labels: { 'swarmy.node.public-ip': '203.0.113.7' } }),
      latestContainers: () => [],
      liveInventory: () => ({ services: [svc(opts.labels ?? {})], containers: [] }),
      dispatch: async (_n: string, cmd: string, payload: { add?: Record<string, string> }) => {
        dispatched.push({ cmd, payload });
        return {};
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched, gated };
}

describe('autoAddressBase', () => {
  it('sslip.io fallback when no zone is flagged', async () => {
    expect(await autoAddressBase(ctxWith({ zones: [{ zone: 'acme.com' }] }).ctx)).toBe('203-0-113-7.sslip.io');
  });
  it('the flagged swarmy zone wins', async () => {
    const { ctx } = ctxWith({ zones: [{ zone: 'acme.com' }, { zone: 'apps.acme.com', settings: { autoAddresses: true } }] });
    expect(await autoAddressBase(ctx)).toBe('apps.acme.com');
  });
});

describe('reconcileAutoAddressesOrg', () => {
  it('own zone: stamps <label>.<zone> and registers it through the DNS gate first', async () => {
    const { ctx, dispatched, gated } = ctxWith({ zones: [{ zone: 'apps.acme.com', settings: { autoAddresses: true } }] });
    const actions = await reconcileAutoAddressesOrg(ctx, 1_000_000);
    expect(actions).toEqual([{ kind: 'add', serviceId: 'svc1', serviceName: 'shop_web', host: 'web-shop.apps.acme.com', port: 3000 }]);
    expect(gated).toEqual(['web-shop.apps.acme.com']);
    const upd = dispatched.find((d) => d.cmd === 'service.updateLabels')!;
    expect(upd.payload.add?.['swarmy.ingress.auto.host']).toBe('web-shop.apps.acme.com');
  });

  it('sslip.io: stamped without the gate (the name embeds the edge IP)', async () => {
    const { ctx, gated } = ctxWith({});
    const actions = await reconcileAutoAddressesOrg(ctx, 2_000_000);
    expect(actions[0]).toMatchObject({ kind: 'add', host: 'web-shop.203-0-113-7.sslip.io' });
    expect(gated).toEqual([]);
  });

  it('flagging a zone re-hosts an existing sslip.io address onto it', async () => {
    const old = 'web-shop.203-0-113-7.sslip.io';
    const { ctx } = ctxWith({
      zones: [{ zone: 'apps.acme.com', settings: { autoAddresses: true } }],
      labels: {
        'swarmy.ingress.routes': JSON.stringify([{ host: old, port: 3000, tls: 'auto' }]),
        'swarmy.ingress.auto.host': old,
      },
    });
    const actions = await reconcileAutoAddressesOrg(ctx, 3_000_000);
    expect(actions).toEqual([
      { kind: 'rehost', serviceId: 'svc1', serviceName: 'shop_web', host: 'web-shop.apps.acme.com', previousHost: old },
    ]);
  });
});
