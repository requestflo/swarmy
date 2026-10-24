import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { setDbExtension } from './manageddb-extensions.service';
import { getDbExtensions } from './manageddb-extensions-view';

const svc = (name: string, labels: Record<string, string>, over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo =>
  ({
    id: name, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', ...labels },
    networks: [], env: [], ports: [], secrets: [], configs: [], createdAt: 0, updatedAt: 0, ...over,
  }) as unknown as SwarmServiceInfo;

const probed = { 'swarmy.db.extensions.probed': 'pgvector/pgvector:pg17', 'swarmy.db.extensions.available': 'pg_stat_statements' };
const primary = (labels: Record<string, string> = {}, over: Partial<SwarmServiceInfo> = {}) =>
  svc('shop_main-primary', { 'swarmy.db.role': 'primary', 'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.node': 'sw1', ...probed, ...labels }, over);
const replica = (over: Partial<SwarmServiceInfo> = {}) => svc('shop_main-replica', { 'swarmy.db.role': 'replica' }, over);

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

const input = (name: 'pg_stat_statements' | 'postgis', on: boolean) => ({ stack: 'shop', cluster: 'main', name, on });

describe('setDbExtension (db.setExtension)', () => {
  it('declares pg_stat_statements on the primary label and audits it; the reconcile does the restart', async () => {
    const w = world([primary(), replica()]);
    const r = await setDbExtension(w.ctx, input('pg_stat_statements', true));
    expect(r).toMatchObject({ changed: true, restartsCopies: true });
    expect(w.calls).toEqual([{ cmd: 'service.updateLabels', payload: {
      service: 'shop_main-primary', add: { 'swarmy.db.extensions': 'pg_stat_statements' }, removeKeys: ['swarmy.db.extensions.error'],
    } }]);
    expect(w.audits.map((a) => a.action)).toEqual(['db.extension.enable']);
  });

  it('is a no-op when already declared', async () => {
    const w = world([primary({ 'swarmy.db.extensions': 'pg_stat_statements' })]);
    expect((await setDbExtension(w.ctx, input('pg_stat_statements', true))).changed).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it('refuses postgis when the image does not ship it (no faking)', async () => {
    const w = world([primary()]);
    await expect(setDbExtension(w.ctx, input('postgis', true))).rejects.toThrow(/needs a postgis image/);
    expect(w.calls).toEqual([]);
  });

  it('postgis is enable-only (DROP would drop geometry columns)', async () => {
    const w = world([primary({ 'swarmy.db.extensions': 'postgis', 'swarmy.db.extensions.available': 'pg_stat_statements,postgis' })]);
    await expect(setDbExtension(w.ctx, input('postgis', false))).rejects.toThrow(/can't be turned off/);
  });

  it('never restarts a primary on temporary storage', async () => {
    const legacy = svc('shop_main-primary', { 'swarmy.db.role': 'primary', ...probed }, { mounts: [] });
    await expect(setDbExtension(world([legacy]).ctx, input('pg_stat_statements', true))).rejects.toThrow(/temporary volume/);
  });

  it('turning the last one off removes the label', async () => {
    const w = world([primary({ 'swarmy.db.extensions': 'pg_stat_statements' })]);
    await setDbExtension(w.ctx, input('pg_stat_statements', false));
    expect(w.calls[0]!.payload.removeKeys).toEqual(['swarmy.db.extensions.error', 'swarmy.db.extensions']);
    expect(w.audits.map((a) => a.action)).toEqual(['db.extension.disable']);
  });
});

describe('getDbExtensions (db.extensions)', () => {
  it('says postgis is not in this image and pg_stat_statements restarts every copy', () => {
    const v = getDbExtensions(world([primary(), replica()]).ctx, { stack: 'shop', cluster: 'main' });
    expect(v.copies).toBe(2);
    expect(v.progress).toBeNull();
    expect(v.extensions).toEqual([
      { name: 'pg_stat_statements', on: false, wanted: false, available: true, restartsCopies: true, canDisable: true },
      { name: 'postgis', on: false, wanted: false, available: false, restartsCopies: false, canDisable: false },
    ]);
  });

  it('shows the standbys restarting first', () => {
    const v = getDbExtensions(world([primary({ 'swarmy.db.extensions': 'pg_stat_statements' }), replica()]).ctx, { stack: 'shop', cluster: 'main' });
    expect(v.progress).toEqual({ kind: 'restart', phase: 'standby', services: ['shop_main-replica'], reason: null });
  });
});
