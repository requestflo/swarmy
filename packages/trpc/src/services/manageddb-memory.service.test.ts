import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { setDbMemory } from './manageddb-memory.service';
import { getDbTopology } from './manageddb.service';

const svc = (name: string, labels: Record<string, string>, over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo =>
  ({
    id: name, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', ...labels },
    networks: [], env: [], ports: [], secrets: [], configs: [], createdAt: 0, updatedAt: 0, ...over,
  }) as unknown as SwarmServiceInfo;
const primary = (labels: Record<string, string> = {}) =>
  svc('shop_main-primary', { 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'sw1', ...labels });
const replica = (labels: Record<string, string> = {}) =>
  svc('shop_main-replica', { 'swarmy.db.role': 'replica', ...labels }, { desiredReplicas: 2, runningReplicas: 2 });

function world(services: SwarmServiceInfo[]) {
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const ctx = {
    db: { auditLog: { create: ({ data }: { data: { action: string } }) => (audits.push(data), Promise.resolve({})) } },
    hub: {
      managerNode: () => 'node1',
      isOnline: () => true,
      liveInventory: () => ({ services, containers: [] }),
      dispatch: (_n: string, cmd: string, payload: Record<string, unknown>) => (calls.push({ cmd, payload }), Promise.resolve({})),
    },
    user: { id: 'u1' },
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  return { ctx, calls, audits };
}

const set = (w: ReturnType<typeof world>, memoryMb: number | null) => setDbMemory(w.ctx, { stack: 'shop', cluster: 'main', memoryMb });

describe('setDbMemory (db.setMemory)', () => {
  it('declares the limit on the primary label, sized 25% / 75%, and audits it', async () => {
    const w = world([primary(), replica()]);
    expect(await set(w, 2048)).toEqual({ stack: 'shop', cluster: 'main', memoryMb: 2048, changed: true, sharedBuffersMb: 512, effectiveCacheSizeMb: 1536, restarts: 3 });
    expect(w.calls).toEqual([{ cmd: 'service.updateLabels', payload: { service: 'shop_main-primary', add: { 'swarmy.db.memoryMb': '2048' }, removeKeys: [] } }]);
    expect(w.audits.map((a) => [a.action, a.metadata?.fromMb, a.metadata?.toMb])).toEqual([['db.memory.set', null, 2048]]);
  });

  it('is a no-op when already declared; null removes the label', async () => {
    const w = world([primary({ 'swarmy.db.memoryMb': '2048' })]);
    expect((await set(w, 2048)).changed).toBe(false);
    expect(w.calls).toEqual([]);
    await set(w, null);
    expect(w.calls[0]!.payload).toEqual({ service: 'shop_main-primary', add: {}, removeKeys: ['swarmy.db.memoryMb'] });
  });

  it('refuses a cluster on temporary storage (a restart would start it empty) and an out-of-range size', async () => {
    const w = world([svc('shop_main-primary', { 'swarmy.db.role': 'primary' }, { mounts: [] } as never)]);
    await expect(set(w, 1024)).rejects.toThrow(/temporary volume/);
    await expect(set(world([primary()]), 100)).rejects.toThrow(/between 256/);
    expect(w.calls).toEqual([]);
  });

  it('db.get shows the declared limit and what each copy runs with', () => {
    const w = world([primary({ 'swarmy.db.memoryMb': '2048', 'swarmy.db.memoryMb.applied': '1024' }), replica({ 'swarmy.db.memoryMb.applied': '2048' })]);
    const c = getDbTopology(w.ctx, 'shop').clusters[0]!;
    expect(c.memoryMb).toBe(2048);
    expect(c.members.map((m) => [m.service, m.memoryMb])).toEqual([['shop_main-primary', 1024], ['shop_main-replica', 2048]]);
  });
});
