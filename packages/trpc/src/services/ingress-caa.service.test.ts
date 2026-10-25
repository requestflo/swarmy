import { afterEach, describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { forgetCaa, getCaa, knownCaaAllows, lookupCaa, type CaaResolve } from './ingress-caa.service';

/** CAA for a routed host: node:dns answers mapped, the tree climbed, the verdict kept for Renew now. No real DNS. */

afterEach(() => forgetCaa());

const nodata = (code = 'ENODATA') => Promise.reject(Object.assign(new Error(code), { code }));
function resolver(zone: Record<string, Array<Record<string, unknown>> | string>): CaaResolve & { asked: string[] } {
  const asked: string[] = [];
  const fn = async (name: string) => {
    asked.push(name);
    const z = zone[name];
    if (typeof z === 'string') return nodata(z);
    return z ?? nodata();
  };
  return Object.assign(fn, { asked });
}

const svc: SwarmServiceInfo = {
  id: 'svc1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': JSON.stringify([{ host: 'shop.northwind.dev', port: 3000, tls: 'auto' }]) },
  networks: [], env: [], ports: [], secrets: [], configs: [],
};
const ctx = { activeOrgId: 'org-caa', hub: { liveInventory: () => ({ services: [svc], containers: [] }) } } as unknown as OrgContext;

describe('lookupCaa', () => {
  it('climbs past names with no data (or NXDOMAIN) and stops at the first set', async () => {
    const r = resolver({ 'shop.northwind.dev': 'ENOTFOUND', 'northwind.dev': [{ critical: 0, issue: 'letsencrypt.org' }, { critical: 0, iodef: 'mailto:ops@northwind.dev' }] });
    expect(await lookupCaa('shop.northwind.dev', r)).toEqual([
      { name: 'shop.northwind.dev', records: [] },
      { name: 'northwind.dev', records: [{ critical: 0, tag: 'issue', value: 'letsencrypt.org' }, { critical: 0, tag: 'iodef', value: 'mailto:ops@northwind.dev' }] },
    ]);
    expect(r.asked).toEqual(['shop.northwind.dev', 'northwind.dev']);
  });

  it('a SERVFAIL stops the climb as an error, not as "none"', async () => {
    expect(await lookupCaa('shop.northwind.dev', resolver({ 'northwind.dev': 'ESERVFAIL' }))).toEqual([
      { name: 'shop.northwind.dev', records: [] },
      { name: 'northwind.dev', error: 'ESERVFAIL' },
    ]);
  });
});

describe('getCaa', () => {
  it('says whether Let’s Encrypt may issue, and keeps it for Renew now', async () => {
    const r = resolver({ 'northwind.dev': [{ critical: 0, issue: 'sectigo.com' }] });
    const v = await getCaa(ctx, 'shop.northwind.dev', r);
    expect(v).toMatchObject({ host: 'shop.northwind.dev', state: 'forbidden', at: 'northwind.dev', asked: ['shop.northwind.dev', 'northwind.dev'] });
    expect(v.ca).toEqual({ name: "Let's Encrypt", caa: 'letsencrypt.org' });
    expect(knownCaaAllows('org-caa', 'shop.northwind.dev')).toBe(false);
    await getCaa(ctx, 'shop.northwind.dev', r);
    expect(r.asked.length).toBe(2); // kept, not asked again
  });

  it('no records anywhere is open (allowed for Renew now); a host that is not routed is NOT_FOUND', async () => {
    expect((await getCaa(ctx, 'shop.northwind.dev', resolver({}))).state).toBe('open');
    expect(knownCaaAllows('org-caa', 'shop.northwind.dev')).toBe(true);
    expect(knownCaaAllows('org-caa', 'other.dev')).toBeNull();
    await expect(getCaa(ctx, 'other.dev', resolver({}))).rejects.toThrow('not found');
  });
});
