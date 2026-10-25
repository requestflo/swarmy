import { describe, expect, it } from 'bun:test';
import { seedKv, useMemoryKv, type OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';

/**
 * `DELETE /stacks/{id}` removes any stack `GET /stacks` lists, through the
 * same service, policy gate and audit as tRPC `stacks.remove`. A label-only
 * stack (here a managed database's: live services, no config row) is listed
 * by its name, so it is removed by its name.
 */

type Role = 'admin' | 'member';
type Call = { node: string; cmd: string; payload: Record<string, unknown> };

const svc = (name: string, stack: string, labels: Record<string, string> = {}, volume?: string) => ({
  id: `id-${name}`, name, image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': stack, ...labels }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
  mounts: volume ? [{ type: 'volume', source: volume, target: '/var/lib/postgresql/data' }] : [],
});

const DB = { 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary' };
const SERVICES = [
  svc('shop_web', 'shop'),
  svc('analytics_main-primary', 'analytics', DB, 'analytics_main-primary-data'),
  svc('analytics_main-replica', 'analytics', { ...DB, 'swarmy.db.role': 'replica' }),
];

function appFor(role: Role, audit: string[], calls: Call[]) {
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: { action: string } }) => void audit.push(data.action) },
    } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } })) },
  );
  const hub = new Proxy(
    {
      liveInventory: () => ({ services: SERVICES, containers: [] }),
      nodeInfoFor: () => undefined,
      managerNode: () => 'mgr1',
      isOnline: () => true,
      onlineNodeIds: () => ['mgr1'],
      dispatch: async (node: string, cmd: string, payload: Record<string, unknown>) => {
        calls.push({ node, cmd, payload });
        return cmd === 'secret.list' ? { secrets: [] } : cmd === 'volume.list' ? { volumes: [] } : {};
      },
    },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : () => { throw new Error(`unmocked hub.${k}`); }) },
  );
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st-shop', { name: 'shop', composeSource: '', ingressDriver: null });
  const ctx = {
    db, hub, user: { id: 'user1' }, activeOrgId: 'org1', membership: { role, orgId: 'org1' }, reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({ resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'], stackNames: null } }) });
}

async function hit(role: Role, method: string, path: string) {
  const audit: string[] = [];
  const calls: Call[] = [];
  const res = await appFor(role, audit, calls).request(path, { method, headers: { authorization: 'Bearer swk_test_x' } });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any>, audit, calls };
}

describe('DELETE /stacks/{id} resolves the set GET /stacks lists', () => {
  it('the list names the label-only database stack by its name', async () => {
    const r = await hit('admin', 'GET', '/stacks');
    expect(r.json.data.map((s: { id: string; name: string }) => `${s.id}=${s.name}`)).toEqual(['st-shop=shop', 'analytics=analytics']);
  });

  it('removes the label-only stack by that id: its services go, its data is kept, audited', async () => {
    const r = await hit('admin', 'DELETE', '/stacks/analytics');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: 'analytics', removed: true, delete_data: false, volumes_deleted: [], volumes_kept: ['analytics_main-primary-data'] });
    expect(r.calls.filter((c) => c.cmd === 'service.remove').map((c) => c.payload.service)).toEqual([
      'analytics_main-primary', 'analytics_main-replica',
    ]);
    expect(r.calls.some((c) => c.cmd === 'volume.remove')).toBe(false);
    expect(r.audit).toContain('stack.remove');
  });

  it('delete_data=true deletes its volumes too, like the dashboard', async () => {
    const r = await hit('admin', 'DELETE', '/stacks/analytics?delete_data=true');
    expect(r.status).toBe(200);
    expect(r.json.volumes_deleted).toEqual(['analytics_main-primary-data']);
    expect(r.calls.find((c) => c.cmd === 'volume.remove')!.payload).toEqual({ name: 'analytics_main-primary-data', cluster: false });
  });

  it('runs the same policy gate: a member is refused and nothing is removed', async () => {
    const r = await hit('member', 'DELETE', '/stacks/analytics');
    expect(r.status).toBe(403);
    expect(r.calls.some((c) => c.cmd === 'service.remove')).toBe(false);
  });

  it('a name the list does not hand out is still 404', async () => {
    expect((await hit('admin', 'DELETE', '/stacks/nope')).status).toBe(404);
    // `shop` is listed by its row id, not its name.
    expect((await hit('admin', 'DELETE', '/stacks/shop')).status).toBe(404);
  });
});
