import { describe, expect, it } from 'bun:test';
import type { DomainCheckRecord } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { mergeDomainChecks, patchDomainChecks, readDomainChecks } from './domain-checks.store';
import { ingressConfigRepo } from './ingress-config.repo';
import { seedKv, useMemoryKv } from './swarm-kv.service';

/** An org whose swarm-kv ingress document holds `settings`; `writes()` counts new versions. */
function ctxWith(orgId: string, settings: Record<string, unknown>) {
  const hub = {} as OrgContext['hub'];
  const drivers = useMemoryKv(hub);
  seedKv(hub, orgId, 'ingress', orgId, { driver: 'CADDY', enabled: true, settings });
  const ctx = { activeOrgId: orgId, hub, db: {} } as unknown as OrgContext;
  const writes = () => drivers.get(orgId)!.calls.filter((c) => c.startsWith('create')).length;
  const stored = async () => (await ingressConfigRepo.get(ctx, orgId)).settings;
  return { ctx, writes, stored };
}

const rec = (over: Partial<DomainCheckRecord> = {}): DomainCheckRecord => ({
  host: 'shop.acme.com',
  addedAt: 1,
  gated: true,
  ...over,
});

describe('domain checks: gate persisted, probes in memory', () => {
  it('persists only the gate fields and keeps probe results in memory', async () => {
    const { ctx, writes, stored: settingsNow } = ctxWith('org_a', { domainChecks: { hosts: {} } });
    await patchDomainChecks(ctx, { upserts: [rec({ lastCheckedAt: 5, nextCheckAt: 9 })] });
    expect(writes()).toBe(1);
    const stored = ((await settingsNow()).domainChecks as { hosts: Record<string, Record<string, unknown>> }).hosts;
    expect(stored['shop.acme.com']).toEqual({ host: 'shop.acme.com', addedAt: 1, gated: true });
    const merged = await readDomainChecks(ctx);
    expect(merged?.hosts['shop.acme.com']).toMatchObject({ gated: true, lastCheckedAt: 5, nextCheckAt: 9 });
  });

  it('a probe-only change writes nothing to the swarm', async () => {
    const { ctx, writes } = ctxWith('org_b', { domainChecks: { hosts: { 'shop.acme.com': rec() } } });
    await patchDomainChecks(ctx, { upserts: [rec({ lastCheckedAt: 7, nextCheckAt: 11 })] });
    expect(writes()).toBe(0);
    expect((await readDomainChecks(ctx))?.hosts['shop.acme.com']?.nextCheckAt).toBe(11);
  });

  it('a gate flip (verified) is persisted', async () => {
    const { ctx, writes } = ctxWith('org_c', { domainChecks: { hosts: { 'shop.acme.com': rec() } } });
    await patchDomainChecks(ctx, { upserts: [rec({ verifiedAt: 42, lastCheckedAt: 42 })] });
    expect(writes()).toBe(1);
  });

  it('after a restart (no memory) every host reads as never checked, so it is re-probed', () => {
    const merged = mergeDomainChecks('org_fresh', {
      domainChecks: { hosts: { 'shop.acme.com': rec({ verifiedAt: 3, nextCheckAt: 999, lastCheckedAt: 998 }) } },
    });
    expect(merged?.hosts['shop.acme.com']).toEqual({ host: 'shop.acme.com', addedAt: 1, gated: true, verifiedAt: 3 });
  });
});
