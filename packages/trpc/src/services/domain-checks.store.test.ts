import { describe, expect, it } from 'bun:test';
import type { DomainCheckRecord } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { mergeDomainChecks, patchDomainChecks, readDomainChecks } from './domain-checks.store';

function ctxWith(orgId: string, settings: Record<string, unknown>) {
  const row = { settings };
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    ingressConfig: {
      findUnique: async () => row,
      update: async (args: { data: { settings: Record<string, unknown> } }) => {
        row.settings = args.data.settings;
        writes.push(args.data.settings);
        return row;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { ctx: { activeOrgId: orgId, db } as unknown as OrgContext, row, writes };
}

const rec = (over: Partial<DomainCheckRecord> = {}): DomainCheckRecord => ({
  host: 'shop.acme.com',
  addedAt: 1,
  gated: true,
  ...over,
});

describe('domain checks: gate persisted, probes in memory', () => {
  it('persists only the gate fields and keeps probe results in memory', async () => {
    const { ctx, row, writes } = ctxWith('org_a', {});
    (row.settings as Record<string, unknown>).domainChecks = { hosts: {} };
    await patchDomainChecks(ctx, { upserts: [rec({ lastCheckedAt: 5, nextCheckAt: 9 })] });
    expect(writes).toHaveLength(1);
    const stored = (row.settings.domainChecks as { hosts: Record<string, Record<string, unknown>> }).hosts;
    expect(stored['shop.acme.com']).toEqual({ host: 'shop.acme.com', addedAt: 1, gated: true });
    const merged = await readDomainChecks(ctx);
    expect(merged?.hosts['shop.acme.com']).toMatchObject({ gated: true, lastCheckedAt: 5, nextCheckAt: 9 });
  });

  it('a probe-only change writes nothing to the database', async () => {
    const { ctx, writes } = ctxWith('org_b', { domainChecks: { hosts: { 'shop.acme.com': rec() } } });
    await patchDomainChecks(ctx, { upserts: [rec({ lastCheckedAt: 7, nextCheckAt: 11 })] });
    expect(writes).toHaveLength(0);
    expect((await readDomainChecks(ctx))?.hosts['shop.acme.com']?.nextCheckAt).toBe(11);
  });

  it('a gate flip (verified) is persisted', async () => {
    const { ctx, writes } = ctxWith('org_c', { domainChecks: { hosts: { 'shop.acme.com': rec() } } });
    await patchDomainChecks(ctx, { upserts: [rec({ verifiedAt: 42, lastCheckedAt: 42 })] });
    expect(writes).toHaveLength(1);
  });

  it('after a restart (no memory) every host reads as never checked, so it is re-probed', () => {
    const merged = mergeDomainChecks('org_fresh', {
      domainChecks: { hosts: { 'shop.acme.com': rec({ verifiedAt: 3, nextCheckAt: 999, lastCheckedAt: 998 }) } },
    });
    expect(merged?.hosts['shop.acme.com']).toEqual({ host: 'shop.acme.com', addedAt: 1, gated: true, verifiedAt: 3 });
  });
});
