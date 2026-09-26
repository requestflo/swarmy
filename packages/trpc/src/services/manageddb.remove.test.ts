import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { removeDb } from './manageddb.service';

const svc = (name: string, labels: Record<string, string>): SwarmServiceInfo =>
  ({
    id: name, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', ...labels }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
  }) as unknown as SwarmServiceInfo;

const PRIMARY = svc('shop_main-primary', { 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data' });
const REPLICA = svc('shop_main-replica', { 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'replica' });

function world(services: SwarmServiceInfo[]) {
  const calls: Array<{ node: string; cmd: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const hub = {
    managerNode: () => 'node1',
    isOnline: () => true,
    onlineNodeIds: () => ['node1', 'node2'],
    latestContainers: () => [],
    nodeInventory: () => [],
    swarmNodeIdFor: () => 'sw1',
    liveInventory: () => ({ services, containers: [] }),
    dispatch: (node: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ node, cmd, payload });
      return Promise.resolve({});
    },
  };
  const ctx = {
    db: { auditLog: { create: ({ data }: { data: { action: string; metadata?: Record<string, unknown> } }) => { audits.push(data); return Promise.resolve({}); } } },
    hub,
    user: null,
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  return { ctx, calls, audits };
}

describe('removeDb (db.remove)', () => {
  it('wants the typed <stack>/<cluster> phrase before touching anything', async () => {
    const w = world([PRIMARY, REPLICA]);
    await expect(removeDb(w.ctx, { stack: 'shop', cluster: 'main', confirm: 'main' })).rejects.toThrow(/type shop\/main/);
    expect(w.calls).toEqual([]);
    expect(w.audits).toEqual([]);
  });

  it('refuses while an app is still connected', async () => {
    const app = svc('shop_web', { 'swarmy.db.inject': 'main' });
    const w = world([PRIMARY, REPLICA, app]);
    await expect(removeDb(w.ctx, { stack: 'shop', cluster: 'main', confirm: 'shop/main' })).rejects.toThrow(/shop_web/);
    expect(w.calls).toEqual([]);
  });

  it('unknown cluster → not found', async () => {
    const w = world([]);
    await expect(removeDb(w.ctx, { stack: 'shop', cluster: 'main', confirm: 'shop/main' })).rejects.toThrow();
  });

  it('removes the primary first, keeps the data by default, and audits', async () => {
    const w = world([REPLICA, PRIMARY]);
    const r = await removeDb(w.ctx, { stack: 'shop', cluster: 'main', confirm: 'shop/main' });
    expect(w.calls.map((c) => [c.cmd, c.payload.service])).toEqual([
      ['service.remove', 'shop_main-primary'],
      ['service.remove', 'shop_main-replica'],
    ]);
    expect(r.volumesDeleted).toEqual([]);
    expect(r.volumesKept).toContain('shop_main-primary-data');
    expect(w.audits.at(-1)?.action).toBe('db.remove');
    expect(w.audits.at(-1)?.metadata?.deleteData).toBe(false);
  });

  it('deleteData removes the volumes from every online server', async () => {
    const w = world([PRIMARY, REPLICA]);
    const r = await removeDb(w.ctx, { stack: 'shop', cluster: 'main', confirm: 'shop/main', deleteData: true });
    const vols = w.calls.filter((c) => c.cmd === 'volume.remove');
    expect(new Set(vols.map((c) => c.node))).toEqual(new Set(['node1', 'node2']));
    expect(r.volumesDeleted).toEqual(['shop_main-primary-data', 'shop_main-replica-data', 'shop_main-wal-archive']);
    expect(r.volumesKept).toEqual([]);
  });
});
