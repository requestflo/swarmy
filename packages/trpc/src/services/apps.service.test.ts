import { describe, expect, it } from 'bun:test';
import { emptyLive, parseAppConfig, planApp, toDesired } from '@swarmy/app-config';
import { authorizationFor, isAppBinding, promoteEnvironment, purgeAppData } from './apps.service';

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
      membership: { id: 'm', role: 'owner', attributes: {} },
      session: { id: 's' },
      reqHeaders: new Headers(),
      db: {
        // The data.destroy check now runs first: an owner passes it.
        member: { findFirst: async () => ({ id: 'm', role: 'owner', organizationId: 'org', attributes: {} }) },
        policy: { findMany: async () => [] },
        resourceGrant: { findMany: async () => [] },
        auditLog: { create: async () => ({}) },
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

describe('promoteEnvironment (staging → production) preconditions', () => {
  const ctx = (rows: Record<string, unknown[]>) =>
    ({
      activeOrgId: 'org',
      user: { id: 'u' },
      db: {
        gitRepo: { findFirst: async () => ({ id: 'r', requireApproval: false }) },
        appPlan: {
          findMany: async (a: { where: { environment: string } }) =>
            rows[a.where.environment] ?? [],
        },
      },
      hub: { liveInventory: () => ({ services: [], containers: [] }) },
    }) as never;

  it('only promotes FROM a named environment', async () => {
    await expect(promoteEnvironment(ctx({}), { repoId: 'r', from: 'production' })).rejects.toThrow(
      'promote FROM a named environment',
    );
  });
  it('needs something applied on both sides, and running digests for every built service', async () => {
    await expect(promoteEnvironment(ctx({}), { repoId: 'r', from: 'staging' })).rejects.toThrow(
      'staging has nothing applied',
    );
    const cfg = parseAppConfig(
      'version: 1\napp: shop\nservices: { web: { build: ., port: 80 } }\n',
    ).config!;
    const staging = toDesired(
      { ...cfg, environments: { staging: { branch: 'staging' } } } as never,
      { environment: 'staging' },
    );
    const prod = toDesired(cfg);
    await expect(
      promoteEnvironment(
        ctx({
          staging: [{ sha: 's', desiredJson: staging }],
          production: [{ sha: 'p', desiredJson: prod }],
        }),
        {
          repoId: 'r',
          from: 'staging',
        },
      ),
    ).rejects.toThrow("staging isn't running web");
  });
});
