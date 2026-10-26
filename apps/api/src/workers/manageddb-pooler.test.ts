import { describe, expect, it } from 'bun:test';
import { poolerSpec } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { convergeDbPooler, repointPoolerAfterPromotion, type PoolerSeams } from './manageddb-pooler';

/**
 * The pooler step of the manageddb reconcile against fake seams: create mints
 * the login (secret + role from a SCRAM verifier) before the deploy, a steady
 * tick sends nothing, a change redeploys with the same login, off removes it.
 */

const svc = (name: string, labels: Record<string, string>, over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', ...labels }, env: [], networks: [], ports: [], secrets: [], configs: [], ...over }) as SwarmServiceInfo;
const POOLER = '{"mode":"transaction","poolSize":20}';
const primary = (labels: Record<string, string> = { 'swarmy.db.pooler': POOLER }, over: Partial<SwarmServiceInfo> = {}) =>
  svc('shop_main-primary', { 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary', ...labels }, over);
const livePooler = (target = 'shop_main-primary', auth = 'shop_main-pg-pooler__v1'): SwarmServiceInfo => {
  const s = poolerSpec({ stack: 'shop', cluster: 'main', config: { mode: 'transaction', poolSize: 20 }, target, authSecret: auth, image: 'edoburu/pgbouncer:v1.26.1-p0' });
  return svc(s.name, s.labels!, { image: `${s.image}@sha256:${'a'.repeat(64)}` });
};

function fake(opts: { secrets?: string[]; roleExit?: number } = {}) {
  const calls: string[] = [];
  const deployed: ServiceSpec[] = [];
  const created = new Map<string, string>();
  const execs: string[][] = [];
  const seams: PoolerSeams = {
    deploy: async (spec) => (deployed.push(spec), calls.push(`deploy ${spec.name} → ${spec.env?.SWARMY_POOLER_HOST}`)),
    remove: async (name) => calls.push(`remove ${name}`),
    ensureNet: async () => calls.push('net'),
    listSecrets: async () => opts.secrets ?? [],
    createSecret: async (name, value) => (created.set(name, value), calls.push(`secret ${name}`), true),
    removeSecret: async (name) => calls.push(`rm-secret ${name}`),
    execOnWriter: async (script, args) => (execs.push([script, ...args]), calls.push('role'), { exitCode: opts.roleExit ?? 0, output: '' }),
    audit: async (action) => calls.push(`audit ${action}`),
  };
  return { seams, calls, deployed, created, execs };
}

const cluster = (p?: SwarmServiceInfo, pooler?: SwarmServiceInfo) => ({ stack: 'shop', cluster: 'main', ...(p ? { primary: p } : {}), ...(pooler ? { pooler } : {}) });

describe('convergeDbPooler', () => {
  it('create: a fresh login secret, the role set from its verifier (never the password), then the deploy', async () => {
    const f = fake({ secrets: ['shop_main-pg-pooler__v1', 'shop_main-pg-password__v1'] });
    expect(await convergeDbPooler(cluster(primary()), f.seams)).toBe('deploy');
    expect(f.calls).toEqual(['secret shop_main-pg-pooler__v2', 'role', 'net', 'deploy shop_main-pooler → shop_main-primary', 'rm-secret shop_main-pg-pooler__v1', 'audit db.pooler.create']);
    const password = f.created.get('shop_main-pg-pooler__v2')!;
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    const [script, verifier] = f.execs[0]!;
    expect(script).toContain('ALTER ROLE swarmy_pooler');
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    for (const part of [...f.execs.flat(), JSON.stringify(f.deployed)]) expect(part).not.toContain(password);
    expect(f.deployed[0]!.secrets).toEqual([{ source: 'shop_main-pg-pooler__v2', target: 'shop_main-pg-pooler' }]);
  });

  it('a failed role setup deploys nothing and drops the secret it just made', async () => {
    const f = fake({ roleExit: 1 });
    expect(await convergeDbPooler(cluster(primary()), f.seams)).toBe('blocked');
    expect(f.calls).toEqual(['secret shop_main-pg-pooler__v1', 'role', 'rm-secret shop_main-pg-pooler__v1']);
  });

  it('steady: the second tick sends nothing', async () => {
    const f = fake();
    expect(await convergeDbPooler(cluster(primary(), livePooler()), f.seams)).toBe('steady');
    expect(f.calls).toEqual([]);
  });

  it('a new pool size redeploys with the same login; no role SQL, no new secret', async () => {
    const f = fake();
    const p = primary({ 'swarmy.db.pooler': '{"mode":"transaction","poolSize":40}' });
    expect(await convergeDbPooler(cluster(p, livePooler()), f.seams)).toBe('deploy');
    expect(f.calls).toEqual(['net', 'deploy shop_main-pooler → shop_main-primary', 'audit db.pooler.update']);
    expect(f.deployed[0]!.env?.SWARMY_POOLER_POOL_SIZE).toBe('40');
    expect(f.deployed[0]!.secrets?.[0]?.source).toBe('shop_main-pg-pooler__v1');
  });

  it('off: the pooler and its login secret go; a writer that is down waits', async () => {
    const f = fake();
    expect(await convergeDbPooler(cluster(primary({}), livePooler()), f.seams)).toBe('remove');
    expect(f.calls).toEqual(['remove shop_main-pooler', 'rm-secret shop_main-pg-pooler__v1', 'audit db.pooler.remove']);
    const g = fake();
    expect(await convergeDbPooler(cluster(primary(undefined, { runningReplicas: 0 })), g.seams)).toBe('wait');
    expect(g.calls).toEqual([]);
  });

  it('after a promotion: repointed at the new writer with the drain on the timeline, once', async () => {
    const deployed: ServiceSpec[] = [];
    const incidents: Array<[string, Record<string, unknown>]> = [];
    const seams = { deploy: async (s: ServiceSpec) => deployed.push(s), incident: async (m: string, meta: Record<string, unknown>) => incidents.push([m, meta]) };
    expect(await repointPoolerAfterPromotion(cluster(primary(), livePooler()), 'shop_main-replica', seams)).toBe('shop_main-pooler');
    expect(deployed.map((s) => s.env?.SWARMY_POOLER_HOST)).toEqual(['shop_main-replica']);
    expect(incidents[0]![1]).toEqual({ pooler: 'shop_main-pooler', from: 'shop_main-primary', to: 'shop_main-replica', drainSeconds: 20 });
    expect(await repointPoolerAfterPromotion(cluster(primary(), livePooler('shop_main-replica')), 'shop_main-replica', seams)).toBeNull();
    expect(deployed).toHaveLength(1);
  });
});
