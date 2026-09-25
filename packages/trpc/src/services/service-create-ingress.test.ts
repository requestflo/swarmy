import { describe, expect, it } from 'bun:test';
import type { CreateServiceInput } from '@swarmy/core';
import { routesFromIngressInput } from './service.service';

const tcp80 = [{ target: 80, protocol: 'tcp', mode: 'ingress' }] as CreateServiceInput['ports'];

describe('image form ingress → routes (QA-008)', () => {
  it('a domain becomes a route on the given target port, lower-cased', () => {
    expect(
      routesFromIngressInput({ enabled: true, domain: 'Shop.Example.com', targetPort: 8080, tls: 'auto' }, tcp80),
    ).toEqual([{ host: 'shop.example.com', port: 8080, tls: 'auto' }]);
  });

  it('target port defaults to the first TCP port; path prefix and custom TLS carry', () => {
    expect(
      routesFromIngressInput({ enabled: true, domain: 'a.example.com', tls: 'custom', pathPrefix: '/api' }, tcp80),
    ).toEqual([{ host: 'a.example.com', port: 80, tls: 'manual', path: '/api' }]);
  });

  it('no domain → no route (the auto-address worker handles it)', () => {
    expect(routesFromIngressInput({ enabled: true, tls: 'auto' }, tcp80)).toBeNull();
    expect(routesFromIngressInput(undefined, tcp80)).toBeNull();
  });

  it('a domain with no port to route to is refused, never dropped', () => {
    expect(() => routesFromIngressInput({ enabled: true, domain: 'a.example.com', tls: 'auto' }, [])).toThrow(
      /needs a target port/,
    );
  });
});

describe('createService carries the domain onto the deployed spec', () => {
  it('the dispatched spec has the routes label + ingress flag', async () => {
    const { createService } = await import('./service.service');
    const dispatched: Array<{ command: string; payload: { spec?: { labels?: Record<string, string> } } }> = [];
    const ctx = {
      activeOrgId: 'org1',
      user: { id: 'user1' },
      membership: { role: 'admin', orgId: 'org1' },
      db: {
        guardrailConfig: { findUnique: async () => ({ rulesJson: [], productionSafetyMode: false }) },
        exposureConfig: { findUnique: async () => null },
        registryConfig: { findUnique: async () => null },
        backupSchedule: { count: async () => 0 },
        auditLog: { create: async ({ data }: { data: unknown }) => data },
      },
      hub: {
        liveInventory: () => ({ services: [], containers: [] }),
        isOnline: () => true,
        managerNode: () => 'node1',
        dispatch: async (_n: string, command: string, payload: never) => {
          dispatched.push({ command, payload });
          return {};
        },
      },
    } as never;
    await createService(ctx, {
      name: 'web',
      image: 'nginx:1.27',
      replicas: 1,
      command: [],
      env: [],
      ports: tcp80,
      volumes: [],
      networks: [],
      constraints: [],
      ingress: { enabled: true, domain: 'shop.example.com', tls: 'auto' },
    }).catch((e) => {
      // Best-effort side calls (DNS gate / edge re-render) may need more of the
      // store than this double has; the deploy dispatch is what matters.
      if (!dispatched.some((d) => d.command === 'service.deploy')) throw e;
    });
    const deploy = dispatched.find((d) => d.command === 'service.deploy');
    expect(deploy?.payload.spec?.labels?.['swarmy.ingress']).toBe('true');
    expect(JSON.parse(deploy?.payload.spec?.labels?.['swarmy.ingress.routes'] ?? '[]')).toEqual([
      { host: 'shop.example.com', port: 80, tls: 'auto' },
    ]);
  });
});
