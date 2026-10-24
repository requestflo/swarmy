import { describe, expect, it } from 'bun:test';
import { setCachePolicy } from './cache-policy.service';
import { getCacheCluster } from './cache.service';

/** cache.setPolicy stamps the DECLARED labels only; cache-reconcile applies them. */
const base = { mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, ports: [], createdAt: 0, updatedAt: 0, configs: [], env: [], secrets: [], networks: [] };
const labels = (role: string, extra: Record<string, string> = {}) => ({
  'com.docker.stack.namespace': 'shop',
  'swarmy.cache.cluster': 'kv',
  'swarmy.cache.engine': 'valkey',
  'swarmy.cache.role': role,
  'swarmy.cache.topology': 'replica',
  ...extra,
});

function world(extra: Record<string, string> = {}) {
  const calls: Array<{ cmd: string; payload: any }> = [];
  const audits: any[] = [];
  const services = [
    { ...base, id: 'p', name: 'shop_kv-cache', image: 'valkey/valkey:8', labels: labels('primary', extra) },
    { ...base, id: 'r', name: 'shop_kv-cache-replica', image: 'valkey/valkey:8', labels: labels('replica', extra) },
  ];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async ({ data }: any) => audits.push(data) } },
    hub: {
      liveInventory: () => ({ services, containers: [] }),
      managerNode: () => 'n1',
      isOnline: () => true,
      dispatch: async (_n: string, cmd: string, payload: any) => {
        calls.push({ cmd, payload });
        return {};
      },
    },
  } as never;
  return { ctx, calls, audits };
}

describe('cache.setPolicy', () => {
  it('stamps the declared labels on every member — labels only, nothing redeployed', async () => {
    const w = world();
    const r = await setCachePolicy(w.ctx, { stack: 'shop', cluster: 'kv', persistence: 'rdb' });
    expect(r).toEqual({ cluster: 'kv', evictionPolicy: 'allkeys-lru', persistence: 'rdb', unchanged: false });
    expect(w.calls.map((c) => c.cmd)).toEqual(['service.updateLabels', 'service.updateLabels']);
    expect(w.calls.map((c) => c.payload.service)).toEqual(['shop_kv-cache', 'shop_kv-cache-replica']);
    expect(w.calls[0]!.payload.add).toEqual({ 'swarmy.cache.evictionPolicy': 'allkeys-lru', 'swarmy.cache.persistence': 'rdb' });
    expect(w.audits[0]).toMatchObject({ action: 'cache.setPolicy' });
  });

  it('an unchanged policy sends nothing', async () => {
    const w = world({ 'swarmy.cache.persistence': 'rdb' });
    const r = await setCachePolicy(w.ctx, { stack: 'shop', cluster: 'kv', persistence: 'rdb' });
    expect(r.unchanged).toBe(true);
    expect(w.calls).toEqual([]);
  });

  it('a queue store refuses an LRU policy', async () => {
    const w = world({ 'swarmy.cache.purpose': 'queue' });
    await expect(setCachePolicy(w.ctx, { stack: 'shop', cluster: 'kv', evictionPolicy: 'allkeys-lru' })).rejects.toThrow('noeviction');
    expect(w.calls).toEqual([]);
  });

  it('the view reads the declared policy and says it is not applied until every running member is', () => {
    const pending = getCacheCluster(world({ 'swarmy.cache.evictionPolicy': 'volatile-lru' }).ctx, { stack: 'shop', cluster: 'kv' });
    expect(pending).toMatchObject({ evictionPolicy: 'volatile-lru', persistence: 'aof', policyApplied: false });
    const done = getCacheCluster(world({ 'swarmy.cache.evictionPolicy': 'volatile-lru', 'swarmy.cache.appliedPolicy': 'volatile-lru/aof' }).ctx, { stack: 'shop', cluster: 'kv' });
    expect(done.policyApplied).toBe(true);
    // Pre-policy clusters read as their old fixed behaviour, already applied.
    expect(getCacheCluster(world().ctx, { stack: 'shop', cluster: 'kv' })).toMatchObject({ evictionPolicy: 'allkeys-lru', persistence: 'aof', policyApplied: true });
  });
});
