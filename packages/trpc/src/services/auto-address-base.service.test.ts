import { afterEach, describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { autoAddressBase, reconcileAutoAddressesOrg } from './auto-address.service';
import { AUTO_ADDRESS_BASE_ENV, getAutoAddressBase, setAutoAddressBase, wildcardBaseFrom } from './auto-address-base.service';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

/** B2(a): the automatic-address base is configurable — env, then the org setting — sslip.io by default. */

function svc(labels: Record<string, string> = {}): SwarmServiceInfo {
  return {
    id: 'svc-base', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
    createdAt: 0, updatedAt: 0, networks: [], env: [], secrets: [], configs: [],
    labels: { 'com.docker.stack.namespace': 'shop', ...labels },
    ports: [{ target: 3000, published: 3000, protocol: 'tcp' as const }],
  } as unknown as SwarmServiceInfo;
}

function ctxWith(settings: Record<string, unknown> = {}, zones: Array<{ zone: string; settings?: object }> = []) {
  const dispatched: Array<Record<string, string> | undefined> = [];
  const ctx = {
    activeOrgId: 'org_1',
    db: { node: { findMany: async () => [{ id: 'n1' }] }, auditLog: { create: async () => ({}) } },
    hub: {
      isOnline: () => true,
      managerNode: () => 'n1',
      nodesByRole: () => ['n1'],
      nodeInfoFor: () => ({ labels: { 'swarmy.node.public-ip': '203.0.113.7' } }),
      latestContainers: () => [],
      liveInventory: () => ({ services: [svc()], containers: [] }),
      dispatch: async (_n: string, _cmd: string, payload: { add?: Record<string, string> }) => {
        dispatched.push(payload.add);
        return {};
      },
    },
  } as unknown as OrgContext;
  useMemoryKv(ctx.hub);
  seedKv(ctx.hub, 'org_1', 'ingress', 'org_1', { driver: 'CADDY', enabled: true, settings: { domainChecks: { hosts: {} }, ...settings } });
  zones.forEach((z, i) => seedKv(ctx.hub, 'org_1', 'dns-zone', `z${i}`, { ...z, enabled: true, mode: 'swarmy-ns', records: [] }));
  return { ctx, dispatched };
}

afterEach(() => {
  delete process.env[AUTO_ADDRESS_BASE_ENV];
});

describe('wildcardBaseFrom', () => {
  it('org setting, else env, else null (= sslip.io); junk is ignored', () => {
    expect(wildcardBaseFrom({}, {})).toBeNull();
    expect(wildcardBaseFrom({}, { [AUTO_ADDRESS_BASE_ENV]: 'NIP.io' })).toBe('nip.io');
    expect(wildcardBaseFrom({ autoAddressBase: 'ip.acme.net' }, { [AUTO_ADDRESS_BASE_ENV]: 'nip.io' })).toBe('ip.acme.net');
    expect(wildcardBaseFrom({ autoAddressBase: 'not a name' }, { [AUTO_ADDRESS_BASE_ENV]: 'nip.io' })).toBe('nip.io');
  });
});

describe('autoAddressBase honours the configured base', () => {
  it('sslip.io by default; SWARMY_AUTO_ADDRESS_BASE; the org setting over the env; the own zone over all', async () => {
    expect(await autoAddressBase(ctxWith().ctx)).toBe('203-0-113-7.sslip.io');
    process.env[AUTO_ADDRESS_BASE_ENV] = 'nip.io';
    expect(await autoAddressBase(ctxWith().ctx)).toBe('203-0-113-7.nip.io');
    expect(await autoAddressBase(ctxWith({ autoAddressBase: 'ip.acme.net' }).ctx)).toBe('203-0-113-7.ip.acme.net');
    const zoned = ctxWith({ autoAddressBase: 'ip.acme.net' }, [{ zone: 'apps.acme.com', settings: { autoAddresses: true } }]);
    expect(await autoAddressBase(zoned.ctx)).toBe('apps.acme.com');
  });

  it('a custom wildcard base is stamped like sslip.io: by construction, never through the DNS gate', async () => {
    const { ctx, dispatched } = ctxWith({ autoAddressBase: 'ip.acme.net' });
    const actions = await reconcileAutoAddressesOrg(ctx, Date.now());
    expect(actions).toEqual([{ kind: 'add', serviceId: 'svc-base', serviceName: 'shop_web', host: 'web-shop.203-0-113-7.ip.acme.net', port: 3000 }]);
    expect(dispatched[0]?.['swarmy.ingress.auto.host']).toBe('web-shop.203-0-113-7.ip.acme.net');
    const doc = peekKv(ctx.hub as never, 'org_1', 'ingress', 'org_1') as { settings: { domainChecks: { hosts: object } } };
    expect(Object.keys(doc.settings.domainChecks.hosts)).toEqual([]);
  });
});

describe('setAutoAddressBase', () => {
  it('normalises, persists in swarm-kv, clears with null, and refuses non-names', async () => {
    process.env[AUTO_ADDRESS_BASE_ENV] = 'nip.io';
    const { ctx } = ctxWith();
    expect(await getAutoAddressBase(ctx)).toEqual({ base: null, envBase: 'nip.io', effective: 'nip.io', defaultBase: 'sslip.io' });
    expect((await setAutoAddressBase(ctx, ' IP.Acme.net. ')).effective).toBe('ip.acme.net');
    const doc = peekKv(ctx.hub as never, 'org_1', 'ingress', 'org_1') as { settings: Record<string, unknown> };
    expect(doc.settings.autoAddressBase).toBe('ip.acme.net');
    expect(await setAutoAddressBase(ctx, null)).toMatchObject({ base: null, effective: 'nip.io' });
    expect('autoAddressBase' in (peekKv(ctx.hub as never, 'org_1', 'ingress', 'org_1') as { settings: object }).settings).toBe(false);
    await expect(setAutoAddressBase(ctx, 'not a domain')).rejects.toThrow('not a domain name');
  });
});
