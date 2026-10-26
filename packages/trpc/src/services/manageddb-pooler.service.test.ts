import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { setDbPooler } from './manageddb-pooler.service';

const svc = (name: string, labels: Record<string, string>): SwarmServiceInfo =>
  ({
    id: name, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', ...labels },
    networks: [], env: [], ports: [], secrets: [], configs: [], createdAt: 0, updatedAt: 0,
  }) as unknown as SwarmServiceInfo;
const primary = (labels: Record<string, string> = {}) => svc('shop_main-primary', { 'swarmy.db.role': 'primary', ...labels });

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

const ref = { stack: 'shop', cluster: 'main' };

describe('setDbPooler (db.setPooler)', () => {
  it('turning it on declares PgBouncer\'s defaults on the primary label and audits it', async () => {
    const w = world([primary()]);
    expect(await setDbPooler(w.ctx, { ...ref, enabled: true })).toEqual({
      ...ref, pooler: { mode: 'transaction', poolSize: 20 }, changed: true, service: 'shop_main-pooler',
    });
    expect(w.calls).toEqual([
      { cmd: 'service.updateLabels', payload: { service: 'shop_main-primary', add: { 'swarmy.db.pooler': '{"mode":"transaction","poolSize":20}' }, removeKeys: [] } },
    ]);
    expect(w.audits.map((a) => [a.action, a.metadata?.from, a.metadata?.to])).toEqual([['db.pooler.set', null, { mode: 'transaction', poolSize: 20 }]]);
  });

  it('a change keeps what it does not name; the same declaration is a no-op; off removes the label', async () => {
    const w = world([primary({ 'swarmy.db.pooler': '{"mode":"session","poolSize":12}' })]);
    expect((await setDbPooler(w.ctx, { ...ref, enabled: true, poolSize: 12 })).changed).toBe(false);
    expect(w.calls).toEqual([]);
    expect((await setDbPooler(w.ctx, { ...ref, enabled: true, poolSize: 30 })).pooler).toEqual({ mode: 'session', poolSize: 30 });
    await setDbPooler(w.ctx, { ...ref, enabled: false });
    expect(w.calls.at(-1)!.payload).toEqual({ service: 'shop_main-primary', add: {}, removeKeys: ['swarmy.db.pooler'] });
  });

  it('refuses a pool size swarmy would not set, and a cluster with no primary', async () => {
    await expect(setDbPooler(world([primary()]).ctx, { ...ref, enabled: true, poolSize: 500 })).rejects.toThrow(/between 1 and 80/);
    await expect(setDbPooler(world([]).ctx, { ...ref, enabled: true })).rejects.toThrow(/not found|primary/i);
  });
});
