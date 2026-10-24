import { describe, expect, it } from 'bun:test';
import { linkNetworkName, type ApiKeyScope } from '@swarmy/core';
import { seedKv, useMemoryKv, type OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';
import { StackConnectionDto, StackEndpointsDto } from '../dto-extra';

/**
 * "Connect apps" over REST rides the SAME services as tRPC `stacks.endpoints`
 * / `connect` / `disconnect`, behind the same policy: `stack.deploy` on BOTH
 * apps (linking into a production peer is a change to that peer). App-scoped
 * keys must reach both apps.
 */

type Role = 'owner' | 'admin' | 'member';

const svc = (name: string, stack: string, opts: { labels?: Record<string, string>; aliases?: string[] } = {}) => ({
  id: `id-${name}`,
  name,
  image: 'x',
  mode: 'replicated',
  replicas: 1,
  runningReplicas: 1,
  desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': stack, ...opts.labels },
  networks: [{ name: `${stack}_default`, aliases: opts.aliases ?? [name.slice(stack.length + 1)] }],
  env: [],
  ports: [],
  createdAt: 0,
  updatedAt: 0,
});

const SERVICES = [
  svc('shop_web', 'shop', {
    labels: {
      'swarmy.ingress.routes': JSON.stringify([{ host: 'shop.example.com', port: 3000 }]),
      'swarmy.db.inject': 'db',
      'swarmy.links': 'billing',
    },
  }),
  svc('shop_db-primary', 'shop', { labels: { 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'primary' }, aliases: [] }),
  svc('billing_api', 'billing'),
  svc('ledger_api', 'ledger', { labels: { 'swarmy.env': 'production' } }),
];

interface Key {
  role?: Role;
  scopes?: ApiKeyScope[];
  stackNames?: string[] | null;
}

function appFor(key: Key, audit: string[], dispatched: { cmd: string; payload: Record<string, unknown> }[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role: key.role ?? 'admin', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy(
    {
      liveInventory: () => ({ services: SERVICES, containers: [] }),
      nodeInfoFor: () => undefined,
      managerNode: () => 'mgr1',
      isOnline: () => true,
      dispatch: async (_node: string, cmd: string, payload: Record<string, unknown>) => {
        dispatched.push({ cmd, payload });
        if (cmd === 'service.inspect') {
          return { inspect: { Spec: { Name: payload.service, TaskTemplate: { ContainerSpec: { Image: 'x' } } } } };
        }
        return {};
      },
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st-shop', { name: 'shop', composeSource: '', ingressDriver: null });
  seedKv(hub as never, 'org1', 'stack', 'st-billing', { name: 'billing', composeSource: '', ingressDriver: null });
  seedKv(hub as never, 'org1', 'stack', 'st-ledger', { name: 'ledger', composeSource: '', ingressDriver: null });
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role: key.role ?? 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({
      ctx,
      apiKey: { id: 'k1', scopes: key.scopes ?? ['write'], stackNames: key.stackNames ?? null },
    }),
  });
}

async function hit(key: Key, method: string, path: string, body?: unknown) {
  const audit: string[] = [];
  const dispatched: { cmd: string; payload: Record<string, unknown> }[] = [];
  const res = await appFor(key, audit, dispatched).request(path, {
    method,
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, audit, dispatched };
}

const PAIR = linkNetworkName('org1', 'billing', 'shop');
const deploys = (d: { cmd: string; payload: Record<string, unknown> }[]) =>
  d.filter((x) => x.cmd === 'service.deploy').map((x) => (x.payload.spec as { name: string }).name);

describe('GET /stacks/{id}/endpoints', () => {
  it('lists the names swarm answers and the managed resources — by stack id or name', async () => {
    const want = {
      stack: 'shop',
      connected_apps: ['billing'],
      services: [
        {
          service: 'shop_web',
          short_name: 'web',
          ports: [3000],
          names: [
            { host: 'web', port: 3000, scope: 'app', reachable_from: [] },
            { host: 'shop_web', port: 3000, scope: 'app', reachable_from: [] },
            { host: 'tasks.web', port: 3000, scope: 'app', reachable_from: [] },
            { host: 'web.shop', port: 3000, scope: 'connected', reachable_from: ['billing'] },
          ],
        },
      ],
      resources: [
        { kind: 'postgres', name: 'db', host: 'shop_db-primary', port: 5432, role: 'primary', attached: ['shop_web'] },
      ],
    };
    for (const id of ['st-shop', 'shop']) {
      const r = await hit({ scopes: ['read'] }, 'GET', `/stacks/${id}/endpoints`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual(want);
      expect(StackEndpointsDto.safeParse(r.json).success).toBe(true);
    }
    expect(await hit({ scopes: ['read'] }, 'GET', '/stacks/nope/endpoints').then((r) => r.status)).toBe(404);
  });

  it('a read is never a command and runs no policy step', async () => {
    const r = await hit({ scopes: ['read'] }, 'GET', '/stacks/st-shop/endpoints');
    expect(r.dispatched).toEqual([]);
    expect(r.audit).toEqual([]);
  });
});

describe('POST /stacks/{id}/connections', () => {
  it('connects through stack.deploy on BOTH apps, then the same connectStacks service', async () => {
    const r = await hit({}, 'POST', '/stacks/st-shop/connections', { peer: 'st-billing' });
    expect(r.status).toBe(200);
    // shop_web already lists billing: only billing's service rolls (idempotent).
    expect(r.json).toEqual({ stack: 'shop', peer: 'billing', network: PAIR, services: ['billing_api'] });
    expect(StackConnectionDto.safeParse(r.json).success).toBe(true);
    expect(r.audit).toEqual(['authz.permit:stack.deploy', 'authz.permit:stack.deploy', 'stack.link.add']);
    expect(r.dispatched[0]).toMatchObject({ cmd: 'network.ensure', payload: { name: PAIR, driver: 'overlay' } });
    expect(deploys(r.dispatched)).toEqual(['billing_api']);
  });

  it("a member can't link into a production peer: 403, the peer's deny audited, nothing dispatched", async () => {
    const r = await hit({ role: 'member' }, 'POST', '/stacks/st-shop/connections', { peer: 'ledger' });
    expect(r.status).toBe(403);
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
    expect(r.audit).toEqual(['authz.permit:stack.deploy', 'authz.deny:stack.deploy']);
    expect(r.dispatched).toEqual([]);
  });

  it('…but may connect two non-production apps (the defaults permit member deploys outside prod)', async () => {
    const r = await hit({ role: 'member' }, 'POST', '/stacks/shop/connections', { peer: 'billing' });
    expect(r.status).toBe(200);
  });

  it('refuses an app connected to itself (400) and a missing peer (400)', async () => {
    const self = await hit({}, 'POST', '/stacks/st-shop/connections', { peer: 'shop' });
    expect(self.status).toBe(400);
    expect(self.json.swarmy_code).toBe('COMMAND_REJECTED');
    expect((await hit({}, 'POST', '/stacks/st-shop/connections', {})).status).toBe(400);
  });

  it('needs the write scope (a Deploy key ships, it does not rewire apps)', async () => {
    const r = await hit({ scopes: ['read', 'deploy'] }, 'POST', '/stacks/st-shop/connections', { peer: 'billing' });
    expect(r.status).toBe(403);
    expect(r.audit).toEqual([]);
  });
});

describe('DELETE /stacks/{id}/connections/{peer}', () => {
  it('disconnects through stack.deploy on both apps and disconnectStacks', async () => {
    const r = await hit({}, 'DELETE', '/stacks/st-shop/connections/billing');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ stack: 'shop', peer: 'billing', network: PAIR, services: ['shop_web'] });
    expect(r.audit).toEqual(['authz.permit:stack.deploy', 'authz.permit:stack.deploy', 'stack.link.remove']);
    expect(deploys(r.dispatched)).toEqual(['shop_web']);
  });

  it("a member can't detach a production peer", async () => {
    const r = await hit({ role: 'member' }, 'DELETE', '/stacks/st-shop/connections/st-ledger');
    expect(r.status).toBe(403);
    expect(r.audit).toEqual(['authz.permit:stack.deploy', 'authz.deny:stack.deploy']);
  });
});

describe('app-scoped keys must reach both apps', () => {
  it('a key limited to shop sees shop, not billing, and cannot connect them (404, no policy step)', async () => {
    const shopOnly = { stackNames: ['shop'] };
    expect((await hit(shopOnly, 'GET', '/stacks/st-shop/endpoints')).status).toBe(200);
    expect((await hit(shopOnly, 'GET', '/stacks/st-billing/endpoints')).status).toBe(404);
    for (const [method, path, body] of [
      ['POST', '/stacks/st-shop/connections', { peer: 'billing' }],
      ['POST', '/stacks/st-billing/connections', { peer: 'shop' }],
      ['DELETE', '/stacks/st-shop/connections/billing', undefined],
    ] as const) {
      const r = await hit(shopOnly, method, path, body);
      expect(r.status).toBe(404);
      expect(r.audit).toEqual([]);
    }
  });

  it('a key on both apps connects them', async () => {
    const r = await hit({ stackNames: ['shop', 'billing'] }, 'POST', '/stacks/st-shop/connections', { peer: 'billing' });
    expect(r.status).toBe(200);
  });
});
