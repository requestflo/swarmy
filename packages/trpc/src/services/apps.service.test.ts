import { describe, expect, it } from 'bun:test';
import { emptyLive, parseAppConfig, planApp, toDesired } from '@swarmy/app-config';
import { authorizationFor, isAppBinding, purgeAppData } from './apps.service';

describe('confirm authorization (by what a step destroys)', () => {
  const cfg = parseAppConfig(
    'version: 1\napp: shop\nservices: { web: { image: "a:1" } }\nresources: { db: postgres }\n',
  ).config!;
  const d = toDesired(cfg);
  const create = planApp(d, emptyLive('shop')).actions[0]!;

  it('maps data steps to data.destroy, workload removal to service.remove', () => {
    expect(
      authorizationFor(
        {
          ...create,
          kind: 'resource.delete',
          name: 'db',
          resourceType: 'postgres',
          id: 'resource.delete:db',
          phase: 6,
          gate: 'confirm',
          reason: '',
        },
        'shop',
        'org',
      ),
    ).toEqual({
      action: 'data.destroy',
      resource: { type: 'managedResource', id: 'shop/db', orgId: 'org' },
    });
    expect(
      authorizationFor(
        {
          kind: 'service.remove',
          name: 'web',
          id: 'service.remove:web',
          phase: 5,
          gate: 'confirm',
          reason: '',
        },
        'shop',
        'org',
      ),
    ).toEqual({
      action: 'service.remove',
      resource: { type: 'service', id: 'shop_web', orgId: 'org' },
    });
    expect(
      authorizationFor(
        {
          kind: 'link.add',
          peer: 'billing',
          id: 'link.add:billing',
          phase: 4,
          gate: 'confirm',
          reason: '',
        },
        'shop',
        'org',
      ).action,
    ).toBe('stack.deploy');
  });

  it('a repo linked to one service is the legacy build path, not an app', () => {
    expect(isAppBinding({ serviceId: null })).toBe(true);
    expect(isAppBinding({ serviceId: 'svc' })).toBe(false);
  });
});

describe('purgeAppData (delete data permanently)', () => {
  const cfg = parseAppConfig(
    'version: 1\napp: shop\nservices: { web: { image: "a:1" } }\nresources: { db: postgres }\n',
  ).config!;
  const withDb = toDesired(cfg);
  const withoutDb = toDesired(
    parseAppConfig('version: 1\napp: shop\nservices: { web: { image: "a:1" } }\n').config!,
  );
  const ctxWith = (desired: unknown, ledger: unknown, services: Array<{ name: string }> = []) =>
    ({
      activeOrgId: 'org',
      user: { id: 'u' },
      db: {
        appPlan: {
          findFirst: async () => ({ desiredJson: desired, ledgerJson: ledger }),
          findMany: async () => [{ ledgerJson: ledger }],
        },
      },
      hub: {
        liveInventory: () => ({
          services: services.map((s) => ({ ...s, id: s.name, spec: {}, labels: {} })),
          containers: [],
        }),
      },
    }) as never;
  const input = { repoId: 'r', environment: 'production', resource: 'db', confirm: 'shop/db' };

  it('needs the typed <stack>/<resource> confirmation', async () => {
    await expect(purgeAppData(ctxWith(withoutDb, {}), { ...input, confirm: 'db' })).rejects.toThrow(
      'type shop/db',
    );
  });
  it('refuses while swarmy.yaml still declares it, or before its removal was confirmed', async () => {
    await expect(purgeAppData(ctxWith(withDb, {}), input)).rejects.toThrow(
      'still declared in swarmy.yaml',
    );
    await expect(
      purgeAppData(ctxWith(withoutDb, { resources: { db: withDb.resources[0] } }), input),
    ).rejects.toThrow('not been removed yet');
  });
});
