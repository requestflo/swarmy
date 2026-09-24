import { describe, expect, it } from 'bun:test';
import { linkNetworkName, type InvService } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { applyServicePatch } from './service-patch';
import { carryLinks, isLinkableService, linkPatch, stackPeers } from './stack-links.service';
import { stackEndpoints } from './service-endpoints';

const ORG = 'org_1';
const NET = linkNetworkName(ORG, 'shop', 'billing');

function svc(name: string, stack: string, extra: Partial<InvService> = {}): InvService {
  return {
    id: name,
    name,
    image: 'img',
    stack,
    mode: 'replicated',
    replicas: { desired: 1, running: 1 },
    status: 'running',
    scaleToZero: false,
    labels: { 'com.docker.stack.namespace': stack },
    networks: [{ name: `${stack}_default`, aliases: [name.slice(stack.length + 1)] }],
    env: [],
    ports: [],
    ...extra,
  } as InvService;
}

describe('connect apps — per-pair overlay, never flat', () => {
  it('linkPatch joins the pair overlay with `<short>.<app>` and keeps the in-app alias', () => {
    const web = svc('shop_web', 'shop');
    const patch = linkPatch(ORG, 'shop', web, ['billing']);
    const base: ServiceSpec = { name: 'shop_web', image: 'img', networks: ['shop_default'] };
    const out = applyServicePatch(base, patch);
    expect(out.networks).toEqual(['shop_default', NET]);
    expect(out.networkAliases).toEqual({ shop_default: ['web'], [NET]: ['web.shop'] });
    expect(out.labels?.['swarmy.links']).toBe('billing');
  });

  it('disconnect (empty peers) leaves the overlay, drops the label and its alias', () => {
    const web = svc('shop_web', 'shop', {
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.links': 'billing' },
      networks: [
        { name: 'shop_default', aliases: ['web'] },
        { name: NET, aliases: ['web.shop'] },
      ],
    });
    const base: ServiceSpec = {
      name: 'shop_web',
      image: 'img',
      networks: ['shop_default', NET],
      labels: { 'swarmy.links': 'billing' },
    };
    const out = applyServicePatch(base, linkPatch(ORG, 'shop', web, []));
    expect(out.networks).toEqual(['shop_default']);
    expect(out.networkAliases).toEqual({ shop_default: ['web'] });
    expect(out.labels?.['swarmy.links']).toBeUndefined();
  });

  it('never links managed-data members (a peer reaches the app, not its database)', () => {
    expect(isLinkableService({ labels: { 'swarmy.db.cluster': 'db' } })).toBe(false);
    expect(isLinkableService({ labels: { 'swarmy.cache.cluster': 'c' } })).toBe(false);
    expect(isLinkableService({ labels: { 'swarmy.system': 'true' } })).toBe(false);
    expect(isLinkableService({ labels: {} })).toBe(true);
  });

  it('a compose redeploy carries links onto rebuilt + newly added services', () => {
    const spec: ServiceSpec = {
      name: 'shop_worker',
      image: 'img',
      networks: ['shop_default'],
      networkAliases: { shop_default: ['worker'] },
    };
    const out = carryLinks(spec, { orgId: ORG, stack: 'shop', peers: ['billing'] });
    expect(out.networks).toEqual(['shop_default', NET]);
    expect(out.networkAliases).toEqual({ shop_default: ['worker'], [NET]: ['worker.shop'] });
    expect(carryLinks(spec, { orgId: ORG, stack: 'shop', peers: [] })).toBe(spec);
  });

  it('stackPeers is the union of the services’ labels', () => {
    expect(
      stackPeers([{ labels: { 'swarmy.links': 'b,c' } }, { labels: { 'swarmy.links': 'a' } }, { labels: {} }]),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('stackEndpoints — what to type from inside the cluster', () => {
  const services: InvService[] = [
    svc('shop_web', 'shop', {
      labels: {
        'com.docker.stack.namespace': 'shop',
        'swarmy.ingress.routes': JSON.stringify([{ host: 'shop.example.com', port: 3000 }]),
        'swarmy.db.inject': 'db',
        'swarmy.s3.bucket': 'media',
        'swarmy.links': 'billing',
      },
    }),
    svc('shop_worker', 'shop'),
    svc('shop_db-primary', 'shop', {
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'primary' },
      networks: [{ name: 'shop_db-net', aliases: [] }],
    }),
    svc('billing_api', 'billing'),
  ];
  const ep = stackEndpoints('shop', services);

  it('app services: short name in-app, full name, tasks.*, and `<svc>.<app>` for connected apps', () => {
    const web = ep.services.find((s) => s.service === 'shop_web')!;
    expect(web.names).toEqual([
      { host: 'web', port: 3000, scope: 'app' },
      { host: 'shop_web', port: 3000, scope: 'app' },
      { host: 'tasks.web', port: 3000, scope: 'app' },
      { host: 'web.shop', port: 3000, scope: 'connected', from: ['billing'] },
    ]);
    expect(ep.connectedApps).toEqual(['billing']);
    expect(ep.services.map((s) => s.service)).toEqual(['shop_web', 'shop_worker']); // db member is a resource
  });

  it('managed resources: host:port and exactly which app services are attached', () => {
    expect(ep.resources).toEqual([
      { kind: 'object-storage', name: 'media', host: 'swarmy-garage', port: 3900, attached: ['shop_web'] },
      { kind: 'postgres', name: 'db', host: 'shop_db-primary', port: 5432, role: 'primary', attached: ['shop_web'] },
    ]);
  });
});
