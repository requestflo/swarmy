import { describe, expect, test } from 'bun:test';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { swarmKvFor, useMemoryKv } from './swarm-kv.service';
import { changedFields, kvDocVersions, listKvDocs, revertKvDoc } from './swarm-kv-versions.service';

function ctxWith(manager: string | null = 'mgr-1') {
  const audit: Array<{ action: string; targetId: string | null; metadata: Record<string, unknown> }> = [];
  const hub = { managerNode: () => manager ?? undefined } as unknown as AgentHub;
  useMemoryKv(hub);
  const db = { auditLog: { create: async ({ data }: { data: (typeof audit)[number] }) => audit.push(data) } };
  const ctx = { hub, db, activeOrgId: 'org1', user: { id: 'u1' } } as unknown as OrgContext;
  return { ctx, hub, audit, kv: swarmKvFor(hub, 'org1') };
}

async function threeVersions(kv: ReturnType<typeof swarmKvFor>) {
  await kv.put('bkp-target', 't1', { name: 'offsite', bucket: 'a', enabled: true });
  await kv.put('bkp-target', 't1', { name: 'offsite', bucket: 'b', enabled: true });
  await kv.put('bkp-target', 't1', { name: 'offsite', bucket: 'b', enabled: false });
}

describe('swarm-kv versions (list / versions / put back)', () => {
  test('lists documents with their name, size and retained versions, never their values', async () => {
    const { ctx, kv } = ctxWith();
    await threeVersions(kv);
    await kv.put('ingress', 'org1', { driver: 'CADDY', credentialRef: 'v1.secret' });
    const view = await listKvDocs(ctx);
    expect(view.available).toBe(true);
    expect(view.docs.map((d) => [d.collection, d.id, d.name, d.seq, d.versions.map((v) => v.seq)])).toEqual([
      ['bkp-target', 't1', 'offsite', 3, [3, 2, 1]],
      ['ingress', 'org1', null, 1, [1]],
    ]);
    expect(view.footprintBytes).toBe(kv.footprint());
    expect(view.maxTotalBytes).toBe(2 * 1024 * 1024);
    expect(JSON.stringify(view)).not.toContain('v1.secret');
  });

  test('says the swarm cannot be read instead of faking an empty list', async () => {
    const { ctx } = ctxWith(null);
    const view = await listKvDocs(ctx);
    expect(view.available).toBe(false);
    expect(view.reason).toContain('no manager');
  });

  test('each older version lists the fields a put-back would change', async () => {
    const { ctx, kv } = ctxWith();
    await threeVersions(kv);
    const versions = await kvDocVersions(ctx, { collection: 'bkp-target', id: 't1' });
    expect(versions.map((v) => [v.seq, v.current, v.changes])).toEqual([
      [3, true, []],
      [2, false, ['enabled']],
      [1, false, ['bucket', 'enabled']],
    ]);
  });

  test('put back writes the old value as a new version and audits it', async () => {
    const { ctx, kv, audit } = ctxWith();
    await threeVersions(kv);
    const res = await revertKvDoc(ctx, { collection: 'bkp-target', id: 't1', seq: 1 });
    expect(res).toEqual({ collection: 'bkp-target', id: 't1', restoredFrom: 1, seq: 4, changed: true });
    expect(await kv.get<object>('bkp-target', 't1')).toEqual({ name: 'offsite', bucket: 'a', enabled: true });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'swarmkv.revert',
      targetId: 'bkp-target/t1',
      metadata: { from: 3, to: 1, newSeq: 4, changed: true },
    });
  });

  test('refuses the current version, a pruned one, an unknown document and an unknown collection', async () => {
    const { ctx, kv, audit } = ctxWith();
    await threeVersions(kv);
    await expect(revertKvDoc(ctx, { collection: 'bkp-target', id: 't1', seq: 3 })).rejects.toThrow(/already the current/);
    await expect(revertKvDoc(ctx, { collection: 'bkp-target', id: 't1', seq: 9 })).rejects.toThrow(/no longer kept/);
    await expect(revertKvDoc(ctx, { collection: 'bkp-target', id: 'nope', seq: 1 })).rejects.toThrow(/no swarm config/);
    await expect(revertKvDoc(ctx, { collection: 'metrics', id: 't1', seq: 1 })).rejects.toThrow(/unknown swarm config collection/);
    expect(audit).toHaveLength(0);
  });

  test('changedFields compares by value, ignoring key order', () => {
    expect(changedFields({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 2, x: 1 }, c: 1 })).toEqual(['b', 'c']);
  });
});
