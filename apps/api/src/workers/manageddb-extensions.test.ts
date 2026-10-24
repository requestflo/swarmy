import { beforeEach, describe, expect, it } from 'bun:test';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { convergePgExtensions, resetExtensionState, type ExtSeams } from './manageddb-extensions';
import { preloadSpec } from './manageddb-reconcile';

/**
 * The extensions step of the manageddb reconcile, against fake seams: one
 * step per tick, standbys before the writer, the writer restarted in place
 * with the planned-restart stamp, CREATE only once the library is live, and
 * nothing at all at steady state.
 */

const IMAGE = 'pgvector/pgvector:pg17';
const svc = (name: string, labels: Record<string, string>, env: string[] = [], over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: IMAGE, mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels, env, networks: [{ name: 'shop_main-net', aliases: [] }], ports: [], secrets: [], configs: [], ...over }) as SwarmServiceInfo;

const base = { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.passwordSecret': 'shop_main-pg-password__v1' };
const probed = { 'swarmy.db.extensions.probed': IMAGE, 'swarmy.db.extensions.available': 'pg_stat_statements' };
const primaryOf = (labels: Record<string, string>, env: string[] = []) =>
  svc('shop_main-primary', { ...base, 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'swarm-a', ...probed, ...labels }, ['SWARMY_PG_ROLE=primary', 'POSTGRES_DB=app', ...env]);
const replicaOf = (env: string[] = [], over: Partial<SwarmServiceInfo> = {}) =>
  svc('shop_main-replica', { ...base, 'swarmy.db.role': 'replica' }, ['SWARMY_PG_ROLE=replica', 'SWARMY_PG_PRIMARY_HOST=shop_main-primary', ...env], over);

function fakeSeams(execOut: (script: string) => { exitCode: number; output: string } | null = () => ({ exitCode: 0, output: '' })) {
  const calls: string[] = [];
  const seams: ExtSeams = {
    exec: async (s, script) => (calls.push(`exec ${s.name} ${script.slice(script.indexOf('-tAc'))}`), execOut(script)),
    setLabels: async (service, add, removeKeys = []) => calls.push(`labels ${service} ${JSON.stringify(add)} -${removeKeys.join(',')}`),
    deploy: async (spec: ServiceSpec) => calls.push(`deploy ${spec.name} ${spec.env?.SWARMY_PG_PRELOAD ?? ''} ${spec.labels?.['swarmy.db.restart.planned'] ? 'planned' : ''}`.trim()),
    restartSpec: (m, preload, plannedAt) => ({ name: m.name, image: IMAGE, env: { SWARMY_PG_PRELOAD: preload }, labels: plannedAt ? { 'swarmy.db.restart.planned': plannedAt } : ({} as Record<string, string>) }),
    audit: async (action) => calls.push(`audit ${action}`),
    writersRedeployable: true,
  };
  return { seams, calls };
}
const cluster = (primary: SwarmServiceInfo, standbys: SwarmServiceInfo[] = []) => ({ key: 'org/shop/main', ref: 'shop/main', primary, standbys, extraWriters: [] });

beforeEach(() => resetExtensionState());

describe('convergePgExtensions', () => {
  it('probes the image once, then is silent at steady state', async () => {
    const { seams, calls } = fakeSeams(() => ({ exitCode: 0, output: 'pg_stat_statements\n' }));
    const fresh = svc('shop_main-primary', { ...base, 'swarmy.db.role': 'primary' });
    await convergePgExtensions(cluster(fresh), seams);
    expect(calls[1]).toBe(`labels shop_main-primary {"swarmy.db.extensions.available":"pg_stat_statements","swarmy.db.extensions.probed":"${IMAGE}"} -`);
    calls.length = 0;
    const c = cluster(primaryOf({}), [replicaOf()]);
    expect(await convergePgExtensions(c, seams)).toEqual({ kind: 'steady' });
    expect(await convergePgExtensions(c, seams)).toEqual({ kind: 'steady' });
    expect(calls).toEqual([]);
  });

  it('turning pg_stat_statements on: standbys, verify, writer in place, verify, CREATE', async () => {
    const P = 'SWARMY_PG_PRELOAD=pg_stat_statements';
    const { seams, calls } = fakeSeams((s) => ({ exitCode: 0, output: s.includes('SHOW') ? 'pg_stat_statements' : '' }));
    const want = { 'swarmy.db.extensions': 'pg_stat_statements' };
    await convergePgExtensions(cluster(primaryOf(want), [replicaOf()]), seams);
    expect(calls).toEqual(['deploy shop_main-replica pg_stat_statements', 'audit db.extension.restart']);
    calls.length = 0;
    await convergePgExtensions(cluster(primaryOf(want), [replicaOf([P])]), seams);
    expect(calls).toEqual(['exec shop_main-replica -tAc "SHOW shared_preload_libraries"']);
    calls.length = 0;
    await convergePgExtensions(cluster(primaryOf(want), [replicaOf([P])]), seams);
    expect(calls).toEqual(['deploy shop_main-primary pg_stat_statements planned', 'audit db.extension.restart']);
    calls.length = 0;
    await convergePgExtensions(cluster(primaryOf(want, [P]), [replicaOf([P])]), seams);
    expect(calls).toEqual(['exec shop_main-primary -tAc "SHOW shared_preload_libraries"']);
    calls.length = 0;
    await convergePgExtensions(cluster(primaryOf(want, [P]), [replicaOf([P])]), seams);
    expect(calls).toEqual([
      'exec shop_main-primary -tAc "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"',
      'labels shop_main-primary {"swarmy.db.extensions.applied":"pg_stat_statements"} -swarmy.db.extensions.error',
      'audit db.extension.create',
    ]);
  });

  it('a standby still restarting holds the writer', async () => {
    const { seams, calls } = fakeSeams();
    const want = { 'swarmy.db.extensions': 'pg_stat_statements' };
    const step = await convergePgExtensions(cluster(primaryOf(want), [replicaOf(['SWARMY_PG_PRELOAD=pg_stat_statements'], { runningReplicas: 0 })]), seams);
    expect(step).toEqual({ kind: 'verify', phase: 'standby', services: ['shop_main-replica'], preload: 'pg_stat_statements' });
    expect(calls.some((c) => c.startsWith('deploy'))).toBe(false);
  });

  it('a failed CREATE is stamped, audited, and not retried', async () => {
    const { seams, calls } = fakeSeams(() => ({ exitCode: 1, output: 'ERROR: extension "postgis" is not available' }));
    await convergePgExtensions(cluster(primaryOf({ 'swarmy.db.extensions': 'postgis' })), seams);
    expect(calls[1]).toBe('labels shop_main-primary {"swarmy.db.extensions.error":"postgis|postgis: ERROR: extension \\"postgis\\" is not available"} -');
    expect(calls[2]).toBe('audit db.extension.create.failed');
    const again = await convergePgExtensions(cluster(primaryOf({ 'swarmy.db.extensions': 'postgis', 'swarmy.db.extensions.error': 'postgis|x' })), seams);
    expect(again?.kind).toBe('blocked');
  });
});

describe('preloadSpec — the restart keeps everything else about the member', () => {
  const primary = primaryOf({}, ['POSTGRES_PASSWORD_FILE=/run/secrets/shop_main-pg-password']);
  const replica = replicaOf();
  const c = { stack: 'shop', cluster: 'main', base: 'shop_main', primary, replica, extraPrimaries: new Map(), regionReplicas: new Map() };
  it('a standby gets the preload, its role and its primary', () => {
    const spec = preloadSpec(c as never, replica, 'pg_stat_statements', [], true);
    expect(spec.env?.SWARMY_PG_PRELOAD).toBe('pg_stat_statements');
    expect(spec.env?.SWARMY_PG_ROLE).toBe('replica');
    expect(spec.env?.SWARMY_PG_PRIMARY_HOST).toBe('shop_main-primary');
    expect(spec.command?.[0]).toBe('/bin/sh');
  });
  it('the writer restarts on its own pinned volume with the planned-restart stamp', () => {
    const spec = preloadSpec(c as never, primary, 'pg_stat_statements', [], true, '2026-10-24T10:00:00.000Z');
    expect(spec.labels?.['swarmy.db.restart.planned']).toBe('2026-10-24T10:00:00.000Z');
    expect(spec.mounts?.find((m) => m.target === '/var/lib/postgresql/data')?.source).toBe('shop_main-primary-data');
    expect(spec.placement?.constraints).toContain('node.id==swarm-a');
    expect(spec.env?.POSTGRES_PASSWORD).toBeUndefined();
  });
  it('turning off drops the env entirely', () => {
    const on = primaryOf({}, ['SWARMY_PG_PRELOAD=pg_stat_statements']);
    expect(preloadSpec({ ...c, primary: on } as never, on, '', [], true).env?.SWARMY_PG_PRELOAD).toBeUndefined();
  });
});
