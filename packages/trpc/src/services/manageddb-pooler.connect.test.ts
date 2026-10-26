import { describe, expect, it } from 'bun:test';
import { carryManagedAttachments } from './attachment-carry';
import { detachConnection } from './manageddb-connect.service';
import { setDbPooler } from './manageddb-pooler.service';
import { injectConnection, provisionDb, rotateDbPassword } from './manageddb.service';
import { APP, CLUSTER, STACK, addApp, world } from './manageddb-testing';

/**
 * Connecting an app "through the pooler": its DATABASE_URL names
 * `<stack>_<cluster>-pooler:6432`, kept as a Docker secret (never a label or
 * plain env), re-minted by a rotation, removed by `db.detach`, and the
 * pooler can't be turned off while an app still goes through it.
 */

async function pooled(password: string) {
  const w = world();
  await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password, autoBackup: false });
  // The fake swarm's updateLabels is a no-op: declare the pooler on the primary directly.
  w.services.get('shop_main-primary')!.labels['swarmy.db.pooler'] = '{"mode":"transaction","poolSize":20}';
  addApp(w);
  return w;
}

describe('an app through the pooler', () => {
  it('gets a pool-URL secret naming the pooler; the RO URL stays direct; nothing on a label', async () => {
    const w = await pooled('pooled-app-password');
    const r = await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP, via: 'pooler' });
    expect(r.rwUrl).toBe('postgres://postgres:***@shop_main-pooler:6432/app');
    expect(r.via).toBe('pooler');
    expect(w.secrets.get('shop_main-pg-pool-url__v1')).toBe('postgres://postgres:pooled-app-password@shop_main-pooler:6432/app');
    const app = w.services.get(APP)!;
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-pool-url__v1', target: 'DATABASE_URL' });
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-ro-url__v1', target: 'DATABASE_RO_URL' });
    expect(app.secretEnv).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    expect(app.labels['swarmy.db.inject.via']).toBe('pooler');
    expect(app.networks.map((n) => n.name)).toContain('shop_main-net');
    for (const v of Object.values(app.labels)) expect(v).not.toContain('shop_main-pooler:6432');
    w.assertNowhere('pooled-app-password');
  });

  it('switching back to direct swaps the secret and drops the label', async () => {
    const w = await pooled('switch-back-password');
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP, via: 'pooler' });
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const app = w.services.get(APP)!;
    expect(app.refs.filter((r) => r.target === 'DATABASE_URL')).toEqual([{ source: 'shop_main-pg-url__v1', target: 'DATABASE_URL' }]);
    expect(app.labels['swarmy.db.inject.via']).toBeUndefined();
  });

  it('a rotation re-mints the pool URL with the new password and retires the old version', async () => {
    const w = await pooled('pre-rotation-password');
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP, via: 'pooler' });
    await rotateDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER }, { pollMs: 1, waitMs: 1000 });
    const next = w.secrets.get('shop_main-pg-password__v2')!;
    expect(w.secrets.get('shop_main-pg-pool-url__v2')).toBe(`postgres://postgres:${next}@shop_main-pooler:6432/app`);
    expect(w.services.get(APP)!.refs).toContainEqual({ source: 'shop_main-pg-pool-url__v2', target: 'DATABASE_URL' });
    expect(w.secrets.has('shop_main-pg-pool-url__v1')).toBe(false);
    w.assertNowhere(next);
  });

  it('detach removes exactly what inject added; the pooler can only go once nobody uses it', async () => {
    const w = await pooled('detach-me-password');
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP, via: 'pooler' });
    await expect(setDbPooler(w.ctx, { stack: STACK, cluster: CLUSTER, enabled: false })).rejects.toThrow(/shop_web connects through the pooler/);
    expect(await detachConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP })).toMatchObject({ via: 'pooler', envVar: 'DATABASE_URL', detached: true });
    const app = w.services.get(APP)!;
    expect(app.refs).toEqual([]);
    expect(app.secretEnv).toBeUndefined();
    expect(app.networks.map((n) => n.name)).toEqual(['shop_default']);
    expect(Object.keys(app.labels).filter((k) => k.startsWith('swarmy.db.'))).toEqual([]);
    expect(app.env).toContain('LOG=debug');
    expect((await setDbPooler(w.ctx, { stack: STACK, cluster: CLUSTER, enabled: false })).changed).toBe(true);
    await expect(detachConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP })).rejects.toThrow(/not connected/);
  });

  it('refuses the pooler path while the cluster has none, and a compose redeploy keeps the path', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'no-pooler-password', autoBackup: false });
    addApp(w);
    await expect(injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP, via: 'pooler' })).rejects.toThrow(/has no pooler/);
    const live = { name: APP, labels: { 'com.docker.stack.namespace': STACK, 'swarmy.db.inject': CLUSTER, 'swarmy.db.inject.via': 'pooler' }, env: [] };
    const carried = carryManagedAttachments({ name: APP, image: 'web:2' }, live as never);
    expect(carried.labels?.['swarmy.db.inject.via']).toBe('pooler');
  });
});
