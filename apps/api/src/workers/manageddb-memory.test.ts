import { beforeEach, describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { convergePgMemory, resetMemoryState, type MemSeams } from './manageddb-memory';
import { memorySpec } from './manageddb-reconcile';

/**
 * The memory step of the manageddb reconcile, against fake seams: standbys
 * restart first, the writer only once they answer the new shared_buffers, in
 * place with the planned-restart stamp, and nothing at all at steady state.
 */

const IMAGE = 'pgvector/pgvector:pg17';
const svc = (name: string, labels: Record<string, string>, env: string[] = [], over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: IMAGE, mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels, env, networks: [{ name: 'shop_main-net', aliases: [] }], ports: [], secrets: [], configs: [], ...over }) as SwarmServiceInfo;
const base = { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.passwordSecret': 'shop_main-pg-password__v1' };
const primaryOf = (labels: Record<string, string>, env: string[] = []) =>
  svc('shop_main-primary', { ...base, 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'swarm-a', ...labels }, ['SWARMY_PG_ROLE=primary', 'POSTGRES_DB=app', ...env]);
const replicaOf = (labels: Record<string, string> = {}, over: Partial<SwarmServiceInfo> = {}) =>
  svc('shop_main-replica', { ...base, 'swarmy.db.role': 'replica', ...labels }, ['SWARMY_PG_ROLE=replica', 'SWARMY_PG_PRIMARY_HOST=shop_main-primary'], over);
const cluster = (primary: SwarmServiceInfo, standbys: SwarmServiceInfo[] = []) => ({ key: 'org/shop/main', primary, standbys, extraWriters: [] });

function fakeSeams(shared = '512MB') {
  const calls: string[] = [];
  const seams: MemSeams = {
    exec: async (s, script) => (calls.push(`exec ${s.name} ${script.slice(script.indexOf('-tAc'))}`), { exitCode: 0, output: `${shared}\n` }),
    deploy: async (spec: ServiceSpec) => calls.push(`deploy ${spec.name} ${spec.labels?.['swarmy.db.memoryMb.applied'] ?? '-'}${spec.labels?.['swarmy.db.restart.planned'] ? ' planned' : ''}`),
    restartSpec: (m, mb, plannedAt) => ({
      name: m.name,
      image: IMAGE,
      labels: { ...(mb === null ? {} : { 'swarmy.db.memoryMb.applied': String(mb) }), ...(plannedAt ? { 'swarmy.db.restart.planned': plannedAt } : {}) },
    }),
    audit: async (action) => calls.push(`audit ${action}`),
    writersRedeployable: true,
  };
  return { seams, calls };
}

beforeEach(() => resetMemoryState());

describe('convergePgMemory', () => {
  it('silent at steady state (no limit declared, none applied)', async () => {
    const { seams, calls } = fakeSeams();
    const c = cluster(primaryOf({}), [replicaOf()]);
    expect(await convergePgMemory(c, seams)).toEqual({ kind: 'steady' });
    expect(await convergePgMemory(c, seams)).toEqual({ kind: 'steady' });
    expect(calls).toEqual([]);
  });

  it('2 GB: the standby restarts, answers 512MB, then the writer restarts in place', async () => {
    const { seams, calls } = fakeSeams('512MB');
    const want = { 'swarmy.db.memoryMb': '2048' };
    await convergePgMemory(cluster(primaryOf(want), [replicaOf()]), seams);
    expect(calls).toEqual(['deploy shop_main-replica 2048', 'audit db.memory.restart']);
    calls.length = 0;

    const restarted = replicaOf({ 'swarmy.db.memoryMb.applied': '2048' });
    await convergePgMemory(cluster(primaryOf(want), [restarted]), seams);
    expect(calls).toEqual(['exec shop_main-replica -tAc "SHOW shared_buffers"']);
    calls.length = 0;

    await convergePgMemory(cluster(primaryOf(want), [restarted]), seams);
    expect(calls).toEqual(['deploy shop_main-primary 2048 planned', 'audit db.memory.restart']);
    calls.length = 0;

    const done = cluster(primaryOf({ ...want, 'swarmy.db.memoryMb.applied': '2048' }), [restarted]);
    expect(await convergePgMemory(done, seams)).toEqual({ kind: 'steady' });
    expect(await convergePgMemory(done, seams)).toEqual({ kind: 'steady' });
    expect(calls).toEqual([]);
  });

  it('a standby that answers the old size holds the writer back', async () => {
    const { seams, calls } = fakeSeams('128MB');
    const c = cluster(primaryOf({ 'swarmy.db.memoryMb': '2048' }), [replicaOf({ 'swarmy.db.memoryMb.applied': '2048' })]);
    await convergePgMemory(c, seams);
    await convergePgMemory(c, seams);
    expect(calls.filter((x) => x.startsWith('deploy'))).toEqual([]);
  });

  it('never restarts a writer on temporary storage', async () => {
    const { seams, calls } = fakeSeams();
    const step = await convergePgMemory(cluster(primaryOf({ 'swarmy.db.memoryMb': '1024' })), { ...seams, writersRedeployable: false });
    expect(step.kind).toBe('blocked');
    expect(calls).toEqual([]);
  });
});

describe('memorySpec — the restart keeps everything else about the member', () => {
  const primary = primaryOf({ 'swarmy.db.memoryMb': '2048' }, ['POSTGRES_PASSWORD_FILE=/run/secrets/shop_main-pg-password', 'SWARMY_PG_PRELOAD=pg_stat_statements']);
  const replica = replicaOf();
  const c = { stack: 'shop', cluster: 'main', base: 'shop_main', primary, replica, extraPrimaries: new Map(), regionReplicas: new Map() };
  it('a standby gets the limit, shared_buffers and effective_cache_size', () => {
    const spec = memorySpec(c as never, replica, 2048, [], true);
    expect(spec.labels?.['swarmy.db.memoryMb.applied']).toBe('2048');
    expect(spec.resources?.limits?.memoryBytes).toBe(2048 * 1024 * 1024);
    expect([spec.env?.SWARMY_PG_SHARED_BUFFERS, spec.env?.SWARMY_PG_EFFECTIVE_CACHE_SIZE, spec.env?.SWARMY_PG_ROLE]).toEqual(['512MB', '1536MB', 'replica']);
  });
  it('the writer keeps its preload, its pinned volume, and stamps the planned restart', () => {
    const spec = memorySpec(c as never, primary, 2048, [], true, '2026-10-25T10:00:00.000Z');
    expect(spec.env?.SWARMY_PG_PRELOAD).toBe('pg_stat_statements');
    expect(spec.labels?.['swarmy.db.restart.planned']).toBe('2026-10-25T10:00:00.000Z');
    expect(spec.placement?.constraints).toContain('node.id==swarm-a');
  });
  it('clearing the limit drops it and the settings', () => {
    const on = replicaOf({ 'swarmy.db.memoryMb.applied': '2048' });
    const spec = memorySpec(c as never, on, null, [], true);
    expect([spec.labels?.['swarmy.db.memoryMb.applied'], spec.env?.SWARMY_PG_SHARED_BUFFERS, spec.resources?.limits?.memoryBytes]).toEqual([undefined, undefined, undefined]);
  });
});
