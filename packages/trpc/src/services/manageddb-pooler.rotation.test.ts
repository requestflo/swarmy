import { describe, expect, it } from 'bun:test';
import { poolerSpec } from '@swarmy/core';
import { injectConnection, migrateDbCredentials, provisionDb, rotateDbPassword } from './manageddb.service';
import { APP, CLUSTER, STACK, addApp, world } from './manageddb-testing';

/**
 * A password rotation with a pooler running: the Postgres members and the
 * apps move onto the new secret, the pooler is not redeployed (it logs in as
 * its own role and looks the new password up through auth_query), and the
 * credential migration never patches it with the Postgres boot layer.
 */

function withPooler() {
  const w = world();
  w.put(poolerSpec({ stack: STACK, cluster: CLUSTER, config: { mode: 'transaction', poolSize: 20 }, target: 'shop_main-primary', authSecret: 'shop_main-pg-pooler__v1', image: 'pooler:1' }));
  return w;
}

describe('rotating the password with a pooler running', () => {
  it('moves members and apps, and leaves the pooler exactly as it was', async () => {
    const w = withPooler();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'before-rotation-pw', autoBackup: false });
    addApp(w);
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const before = structuredClone(w.services.get('shop_main-pooler')!);
    const res = await rotateDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER }, { pollMs: 1, waitMs: 1000 });
    expect(res.redeployed).toEqual(['shop_main-primary', 'shop_main-replica', APP]);
    expect(w.services.get('shop_main-pooler')).toEqual(before);
    expect(w.services.get(APP)!.refs).toContainEqual({ source: 'shop_main-pg-url__v2', target: 'DATABASE_URL' });
    w.assertNowhere('before-rotation-pw');
  });

  it('the credential migration never treats the pooler as a member', async () => {
    const w = withPooler();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'migrate-me-pw', autoBackup: false });
    const gen = w.services.get('shop_main-pooler')!.gen;
    expect((await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER })).members).toEqual([]);
    expect(w.services.get('shop_main-pooler')!.gen).toBe(gen);
  });
});
