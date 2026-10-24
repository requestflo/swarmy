import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { restoreDbAsCopy } from './dbRestoreCopy.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * "Restore as a copy" creates its own database beside the original, waits
 * for it, restores into it, and wires it into nothing. Against an in-memory
 * hub whose inventory grows as services are deployed.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-restore-copy';

const OCT_24 = new Date('2026-10-24T12:00:00Z');
type Payload = Record<string, unknown>;

function world(opts: { restoreFails?: string; saves?: string[]; existing?: string[] } = {}) {
  const calls: Array<{ cmd: string; payload: Payload }> = [];
  const audits: Array<{ action: string; targetId?: string; metadata: Payload }> = [];
  const svc = (name: string, labels: Record<string, string>, image = 'pgvector/pgvector:pg16@sha256:abc', env: string[] = []) => ({
    id: `id-${name}`, name, image, mode: 'replicated' as const, desiredReplicas: 1, runningReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', ...labels }, env, networks: [], ports: [], secrets: [], configs: [], createdAt: 0, updatedAt: 0,
  });
  const primary = (cluster: string, extra: Record<string, string> = {}) =>
    svc(`shop_${cluster}-primary`, { 'swarmy.db.cluster': cluster, 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary', ...extra }, undefined, ['POSTGRES_DB=orders']);
  const services = [primary('main', { 'swarmy.db.node': 'sw-a' }), ...(opts.existing ?? []).map((c) => primary(c))];
  const containers: Array<Record<string, unknown>> = [];
  const nodes = [
    { swarmNodeId: 'sw-a', hostname: 'a', role: 'manager', status: 'ready', availability: 'active', labels: { 'swarmy.region': 'eu' } },
    { swarmNodeId: 'sw-b', hostname: 'b', role: 'worker', status: 'ready', availability: 'active', labels: { 'swarmy.region': 'us' } },
    { swarmNodeId: 'sw-c', hostname: 'c', role: 'worker', status: 'ready', availability: 'active', labels: { 'swarmy.region': 'eu' } },
  ];
  const hub = {
    managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], nodeInventory: () => nodes,
    swarmNodeIdFor: () => 'sw-a', nodeInfoFor: () => nodes[0],
    latestContainers: () => containers,
    liveInventory: () => ({ services, containers }),
    dispatch: async (_n: string, cmd: string, payload: Payload) => {
      calls.push({ cmd, payload });
      if (cmd === 'service.deploy') {
        const spec = payload.spec as { name: string; image: string; labels: Record<string, string>; env?: Record<string, string> };
        const s = svc(spec.name, spec.labels, spec.image, Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`));
        services.push(s);
        containers.push({ id: `c-${spec.name}`, name: spec.name, image: spec.image, state: 'running', status: 'Up', createdAt: 1, ports: [], labels: {}, serviceId: s.id });
      }
      if (cmd === 'exec') return { exitCode: 0, output: (payload.cmd as string[]).includes('cat') ? 'pw' : 'accepting connections' };
      if (cmd === 'backup.list') return { snapshots: (opts.saves ?? []).map((id, i) => ({ id, time: `2026-10-2${i}T03:00:00Z`, tags: ['engine:pg_dump'], paths: [] })) };
      if (cmd === 'db.restore') {
        if (opts.restoreFails) throw new Error(opts.restoreFails);
        return { mode: payload.mode, engine: payload.engine, bytesRestored: 42 };
      }
      return {};
    },
  };
  const db = { auditLog: { create: async (a: { data: { action: string; targetId?: string; metadata: Payload } }) => (audits.push(a.data), {}) } };
  seedKvRows(hub as never, 'org1', 'bkp-target', [
    { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: null, region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true },
  ]);
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org1', session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  const deployed = (name: string) => calls.find((c) => c.cmd === 'service.deploy' && (c.payload.spec as { name: string }).name === name)?.payload.spec as
    | { image: string; labels: Record<string, string>; env: Record<string, string>; mode: { replicated: { replicas: number } } }
    | undefined;
  return { ctx, calls, audits, deployed, cmds: () => calls.map((c) => c.cmd) };
}

const input = { stack: 'shop', cluster: 'main', engine: 'pg_dump' as const, targetId: 'tgt-1' };

describe('restoreDbAsCopy — the copy restore makes its own database', () => {
  it('creates <cluster>-restore-<mmdd> like the source, waits for it, then restores into it', async () => {
    const w = world({ saves: ['old1', 'new1'] });
    const r = await restoreDbAsCopy(w.ctx, input, OCT_24);
    expect(r.copy).toEqual({ stack: 'shop', cluster: 'main-restore-1024', primaryService: 'shop_main-restore-1024-primary', rwHost: 'shop_main-restore-1024-primary' });
    const spec = w.deployed('shop_main-restore-1024-primary')!;
    expect(spec.image).toBe('pgvector/pgvector:pg16'); // same engine + version, digest dropped like a re-provision
    expect(spec.env.POSTGRES_DB).toBe('orders');
    expect(spec.labels['swarmy.db.topology']).toBe('single');
    expect(spec.labels['swarmy.db.node']).toBe('sw-c'); // stays in the source's region (eu), beside it
    expect(w.deployed('shop_main-restore-1024-replica')?.mode.replicated.replicas).toBe(0);
    // Snapshot pinned before anything was created; the wait (pg_isready) comes before the restore.
    expect(w.cmds().indexOf('backup.list')).toBeLessThan(w.cmds().indexOf('service.deploy'));
    const restore = w.calls.find((c) => c.cmd === 'db.restore')!;
    expect(w.cmds().lastIndexOf('exec')).toBeLessThan(w.calls.indexOf(restore));
    expect(restore.payload).toMatchObject({ mode: 'clone-to-new-cluster', snapshotId: 'new1', network: 'shop_main-restore-1024-net' });
    expect((restore.payload.conn as { host: string }).host).toBe('shop_main-restore-1024-primary');
    // No safety copy (nothing live is written over) and no app is rewired.
    expect(w.cmds()).not.toContain('db.backup');
    expect(w.cmds().filter((c) => c === 'service.deploy')).toHaveLength(2);
    expect(r.safetySnapshotId).toBeNull();
    const row = w.audits.find((a) => a.action === 'db.restore.copy');
    expect(row?.targetId).toBe('shop/main-restore-1024');
    expect(row?.metadata).toMatchObject({ source: 'shop/main', snapshotId: 'new1', status: 'succeeded' });
  });

  it('never reuses a name, and refuses a name that is taken before touching anything', async () => {
    const w = world({ saves: ['s1'], existing: ['main-restore-1024'] });
    expect((await restoreDbAsCopy(w.ctx, input, OCT_24)).copy.cluster).toBe('main-restore-1024-2');
    const w2 = world({ saves: ['s1'], existing: ['main-restore-1024'] });
    await expect(restoreDbAsCopy(w2.ctx, { ...input, name: 'main-restore-1024' }, OCT_24)).rejects.toThrow(/already exists/);
    expect(w2.cmds()).toEqual([]);
  });

  it('with nothing to restore it creates nothing', async () => {
    const w = world({ saves: [] });
    await expect(restoreDbAsCopy(w.ctx, input, OCT_24)).rejects.toThrow(/no pg_dump backup of shop\/main/);
    expect(w.cmds()).not.toContain('service.deploy');
    expect(w.audits.some((a) => a.action === 'db.restore.copy')).toBe(false);
  });

  it('a failed restore removes the copy again (its volume is kept) and says so in the audit', async () => {
    const w = world({ saves: ['s1'], restoreFails: 'restic: repository not found' });
    await expect(restoreDbAsCopy(w.ctx, input, OCT_24)).rejects.toThrow(/repository not found/);
    const removed = w.calls.filter((c) => c.cmd === 'service.remove').map((c) => c.payload.service);
    expect(removed).toEqual(['shop_main-restore-1024-primary', 'shop_main-restore-1024-replica']);
    expect(w.cmds()).not.toContain('volume.remove');
    expect(w.audits.find((a) => a.action === 'db.restore.copy')?.metadata).toMatchObject({ status: 'failed', removed });
  });
});
