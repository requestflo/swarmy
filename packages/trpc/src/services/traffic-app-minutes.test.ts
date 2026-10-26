import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { EdgeTrafficRing, MINUTE_MS } from '@swarmy/core';
import type { OrgContext } from '../context';
import { appTrafficMinutes } from './traffic-app-minutes';

const M0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function svc(name: string, stack: string, hosts: string[]): SwarmServiceInfo {
  return {
    id: name,
    name,
    image: 'x:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: {
      'com.docker.stack.namespace': stack,
      'swarmy.ingress.routes': JSON.stringify(hosts.map((host) => ({ host, port: 80 }))),
    },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  };
}

function ctxWith(ring: EdgeTrafficRing): OrgContext {
  return {
    activeOrgId: 'org',
    hub: {
      edgeTraffic: () => ring,
      liveInventory: () => ({
        services: [svc('shop_web', 'shop', ['shop.example.com', 'www.shop.example.com']), svc('blog_ghost', 'blog', ['blog.example.com'])],
        containers: [],
      }),
    },
  } as unknown as OrgContext;
}

describe('appTrafficMinutes', () => {
  it('sums every edge and every host of the app, per minute, and leaves other apps out', () => {
    const ring = new EdgeTrafficRing();
    // Two edges report a whole minute each for the shop; the blog's traffic is not the shop's.
    const sample = (hosts: Array<{ host: string; requests: number; errors5xx: number }>) => ({ sampledAt: 0, intervalSec: 60, hosts });
    ring.record('org', 'eu1', sample([{ host: 'shop.example.com', requests: 100, errors5xx: 4 }, { host: 'blog.example.com', requests: 50, errors5xx: 50 }]), M0 + MINUTE_MS);
    ring.record('org', 'us1', sample([{ host: 'www.shop.example.com', requests: 20, errors5xx: 1 }]), M0 + MINUTE_MS);
    ring.record('org', 'eu1', sample([{ host: 'shop.example.com', requests: 80, errors5xx: 0 }]), M0 + 2 * MINUTE_MS);
    const minutes = appTrafficMinutes(ctxWith(ring), 'shop', M0 - MINUTE_MS, M0 + 3 * MINUTE_MS);
    expect(minutes).toEqual([
      { t: M0, requests: 120, errors5xx: 5 },
      { t: M0 + MINUTE_MS, requests: 80, errors5xx: 0 },
    ]);
  });

  it('is empty with no edge traffic', () => {
    expect(appTrafficMinutes(ctxWith(new EdgeTrafficRing()), 'shop', M0, M0 + MINUTE_MS)).toEqual([]);
  });
});
