import { describe, expect, it, beforeEach } from 'bun:test';
import { checkOnDemand, normalizeHost, _resetAskCache, type OnDemandDeps } from './ingress-ask';

/** Deps stub: routes live on the swarmy.ingress.routes label of a live service. */
function depsWith(hosts: string[]): OnDemandDeps {
  const routes = hosts.map((host) => ({ host, port: 80, tls: 'auto' }));
  return {
    listOrgIds: async () => ['org_1'],
    liveInventory: () => ({
      services: [
        { id: 'svc_1', name: 'web', labels: { 'swarmy.ingress.routes': JSON.stringify(routes) } } as never,
      ],
      containers: [],
    }),
  };
}

describe('normalizeHost', () => {
  it('lowercases and strips trailing dot + port', () => {
    expect(normalizeHost('App.Example.COM')).toBe('app.example.com');
    expect(normalizeHost('app.example.com.')).toBe('app.example.com');
    expect(normalizeHost('app.example.com:443')).toBe('app.example.com');
  });
});

describe('checkOnDemand', () => {
  beforeEach(() => _resetAskCache());

  it('200 for a registered domain', async () => {
    const res = await checkOnDemand(depsWith(['app.example.com']), 'app.example.com');
    expect(res.status).toBe(200);
  });

  it('matches case-insensitively', async () => {
    const res = await checkOnDemand(depsWith(['app.example.com']), 'APP.example.com');
    expect(res.status).toBe(200);
  });

  it('403 (deny-by-default) for an unknown domain', async () => {
    const res = await checkOnDemand(depsWith(['app.example.com']), 'evil.attacker.com');
    expect(res.status).toBe(403);
  });

  it('400 for a missing or malformed domain', async () => {
    expect((await checkOnDemand(depsWith([]), undefined)).status).toBe(400);
    expect((await checkOnDemand(depsWith([]), 'has space')).status).toBe(400);
    expect((await checkOnDemand(depsWith([]), 'a/b')).status).toBe(400);
  });

  it('serves a positive result from cache without re-scanning the inventory', async () => {
    let hits = 0;
    const deps: OnDemandDeps = {
      listOrgIds: async () => ['org_1'],
      liveInventory: () => {
        hits += 1;
        return {
          services: [
            {
              id: 'svc_1',
              name: 'web',
              labels: { 'swarmy.ingress.routes': JSON.stringify([{ host: 'cached.example.com', port: 80, tls: 'auto' }]) },
            } as never,
          ],
          containers: [],
        };
      },
    };
    await checkOnDemand(deps, 'cached.example.com');
    await checkOnDemand(deps, 'cached.example.com');
    expect(hits).toBe(1);
  });
});
