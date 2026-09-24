import { describe, expect, it } from 'bun:test';
import { emptyLive, parseAppConfig, planApp, toDesired } from '@swarmy/app-config';
import { authorizationFor, isAppBinding } from './apps.service';

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
