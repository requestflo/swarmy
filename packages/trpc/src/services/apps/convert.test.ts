import { describe, expect, it } from 'bun:test';
import { parseAppConfig, toDesired } from '@swarmy/app-config';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../../context';
import { seedKvRows } from '../swarm-kv.service';
import { conversionView, convertToConfig } from './convert';

const SHOP = `
services:
  web:
    image: ghcr.io/northwind/shop:2.1
    ports: ["8080:3000"]
    privileged: true
    environment:
      DATABASE_URL: postgres://shop:hunter22@db:5432/shop
      STRIPE_API_KEY: rk_live_8f2c41d9a7
    volumes: ["./uploads:/app/uploads"]
  db:
    image: postgres:16
    volumes: [pgdata:/var/lib/postgresql/data]
`;

/** A fake ctx: live services, git-app plans by stack, and a swarm-kv the Stack rows live in. */
function ctxWith(opts: { live?: Array<Partial<SwarmServiceInfo>>; planned?: string[] } = {}): OrgContext {
  return {
    activeOrgId: 'org1',
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: { orgId: string; stack: string } }) =>
          where.orgId === 'org1' && opts.planned?.includes(where.stack) ? { id: 'plan1' } : null,
      },
    },
    hub: { liveInventory: () => ({ services: opts.live ?? [], containers: [] }) },
  } as unknown as OrgContext;
}

describe('conversionView', () => {
  const v = conversionView('shop', SHOP);

  it('round-trips: the file parses clean with the controller’s parser, and toDesired builds the app', () => {
    expect(v.yaml).not.toBeNull();
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    const parsed = parseAppConfig(v.yaml!);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const desired = toDesired(parsed.config!);
    expect(desired.stack).toBe('shop');
    expect(desired.services.map((s) => s.name)).toEqual(['web']);
    expect(desired.resources.map((r) => [r.name, r.type])).toEqual([['db', 'postgres']]);
  });

  it('lists what didn’t translate, with a reason for each', () => {
    const keys = v.untranslated.map((g) => `${g.service} ${g.key}`);
    expect(keys).toEqual(
      expect.arrayContaining(['web privileged', 'web volumes: ./uploads:/app/uploads', 'web ports: 8080:3000', 'web environment.STRIPE_API_KEY', 'db volumes: pgdata:/var/lib/postgresql/data']),
    );
    for (const g of v.untranslated) expect(g.reason.length).toBeGreaterThan(10);
    expect(v.changes.some((c) => c.includes('${{ db.url }}'))).toBe(true);
  });

  it('never writes the compose’s credentials into the file', () => {
    expect(v.yaml).not.toContain('hunter22');
    expect(v.yaml).not.toContain('rk_live_8f2c41d9a7');
  });

  it('says why when there is nothing to convert', () => {
    const empty = conversionView('db-only', 'services:\n  db:\n    image: postgres:16\n');
    expect(empty).toMatchObject({ yaml: null, valid: false, issues: [] });
    expect(empty.reason).toContain('no app service');
  });
});

describe('convertToConfig', () => {
  it('converts the compose swarmy deployed the app from (the Stack row), org-scoped', async () => {
    const ctx = ctxWith();
    seedKvRows(ctx.hub, 'org1', 'stack', [{ id: 'stack-shop', name: 'shop', composeSource: SHOP }]);
    seedKvRows(ctx.hub, 'org2', 'stack', [{ id: 'stack-other', name: 'other', composeSource: SHOP }]);
    const v = await convertToConfig(ctx, { stack: 'shop' });
    expect(v.valid).toBe(true);
    expect(v.yaml).toContain('app: shop');
    const other = await convertToConfig(ctx, { stack: 'other' });
    expect(other.yaml).toBeNull();
    expect(other.reason).toContain("didn't deploy other from compose");
  });

  it('refuses a git app and swarmy’s own stacks', async () => {
    await expect(convertToConfig(ctxWith({ planned: ['storefront'] }), { stack: 'storefront' })).rejects.toThrow('already runs from a swarmy.yaml');
    await expect(convertToConfig(ctxWith(), { stack: 'swarmy-system' })).rejects.toThrow('swarmy manages');
    const live = [{ id: 's1', name: 'swarmy_controller', image: 'x', labels: { 'com.docker.stack.namespace': 'swarmy', 'swarmy.system': 'true' } }];
    await expect(convertToConfig(ctxWith({ live }), { stack: 'swarmy' })).rejects.toThrow('swarmy manages');
  });
});
