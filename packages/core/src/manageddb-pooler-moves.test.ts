import { describe, expect, it } from 'bun:test';
import { primaryDeclarations } from './manageddb-memory';
import { encodePoolerConfig, type PoolerConfig } from './manageddb-pooler';
import { planPooler, planPoolerRepoint } from './manageddb-pooler-plan';
import { planPoolerRotation } from './manageddb-pooler-rotation';
import { poolerSpec } from './manageddb-pooler-spec';

/**
 * The two moments a pooler must survive: a promotion (it is repointed at the
 * new writer in the same pass, and the next tick is steady) and a password
 * rotation (it is left alone and keeps authenticating).
 */

const CONFIG: PoolerConfig = { mode: 'transaction', poolSize: 20 };
const AUTH = 'shop_main-pg-pooler__v1';
const live = (target: string) => {
  const s = poolerSpec({ stack: 'shop', cluster: 'main', config: CONFIG, target, authSecret: AUTH, image: 'edoburu/pgbouncer:v1.26.1-p0' });
  return { name: s.name, image: `${s.image}@sha256:${'a'.repeat(64)}`, labels: s.labels! };
};
const ref = { stack: 'shop', cluster: 'main' };

describe('after a promotion the pooler follows the writer', () => {
  it('is rebuilt at the promoted standby with its existing login, and says it drained', () => {
    const r = planPoolerRepoint({ ...ref, declared: CONFIG, pooler: live('shop_main-primary'), promoted: 'shop_main-replica' })!;
    expect(r.from).toBe('shop_main-primary');
    expect(r.to).toBe('shop_main-replica');
    expect(r.spec.env?.SWARMY_POOLER_HOST).toBe('shop_main-replica');
    expect(r.spec.secrets).toEqual([{ source: AUTH, target: 'shop_main-pg-pooler' }]);
    expect(r.spec.updateConfig?.order).toBe('start-first');
    expect(r.message).toBe(
      'Drained shop_main-pooler off shop_main-primary: a new pooler task sends apps to shop_main-replica, the old one finishes in-flight transactions (up to 20 s) and stops',
    );
  });

  it('the next tick, reading the declaration the new writer inherited, is steady', () => {
    const declared = { 'swarmy.db.pooler': encodePoolerConfig(CONFIG), 'swarmy.db.role': 'primary' };
    expect(primaryDeclarations(declared)).toEqual({ 'swarmy.db.pooler': '{"mode":"transaction","poolSize":20}' });
    const r = planPoolerRepoint({ ...ref, declared: CONFIG, pooler: live('shop_main-primary'), promoted: 'shop_main-replica' })!;
    const after = { name: r.spec.name, image: `${r.spec.image}@sha256:${'b'.repeat(64)}`, labels: r.spec.labels! };
    expect(planPooler({ ...ref, declared: CONFIG, writer: { name: 'shop_main-replica', running: 1 }, pooler: after })).toEqual({ kind: 'steady' });
  });

  it('nothing to repoint: no pooler, none declared, no login yet, or already there', () => {
    expect(planPoolerRepoint({ ...ref, declared: CONFIG, promoted: 'shop_main-replica' })).toBeNull();
    expect(planPoolerRepoint({ ...ref, declared: null, pooler: live('shop_main-primary'), promoted: 'shop_main-replica' })).toBeNull();
    expect(planPoolerRepoint({ ...ref, declared: CONFIG, pooler: { ...live('x'), labels: {} }, promoted: 'shop_main-replica' })).toBeNull();
    expect(planPoolerRepoint({ ...ref, declared: CONFIG, pooler: live('shop_main-replica'), promoted: 'shop_main-replica' })).toBeNull();
  });
});

describe('a password rotation leaves the pooler alone', () => {
  const pg = (name: string, role: string) => ({ name, labels: { 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': role } });
  const services = [
    pg('shop_main-primary', 'primary'),
    pg('shop_main-replica', 'replica'),
    { name: 'shop_main-pooler', labels: live('shop_main-primary').labels },
    { name: 'shop_main-wal-shipper', labels: { 'swarmy.db.cluster': 'main', 'swarmy.db.walShipper': 'true' } },
    { name: 'shop_web', labels: { 'swarmy.db.inject': 'main', 'swarmy.db.inject.var': 'DATABASE_URL', 'swarmy.db.inject.via': 'pooler' } },
    { name: 'shop_admin', labels: { 'swarmy.db.inject': 'main' } },
    { name: 'shop_other', labels: { 'swarmy.db.inject': 'other' } },
  ];

  it('moves only the Postgres members, re-mints each app on its own path, and retires pool URLs too', () => {
    expect(planPoolerRotation('main', services)).toEqual({
      members: ['shop_main-primary', 'shop_main-replica'],
      untouched: ['shop_main-pooler', 'shop_main-wal-shipper'],
      apps: [
        { service: 'shop_web', envVar: 'DATABASE_URL', via: 'pooler' },
        { service: 'shop_admin', envVar: 'DATABASE_URL', via: 'direct' },
      ],
      retire: ['password', 'url', 'ro-url', 'pool-url'],
    });
  });

  it('keeps authenticating: nothing the rotation changes is an input of the pooler', () => {
    const pooler = live('shop_main-primary');
    const before = planPooler({ ...ref, declared: CONFIG, writer: { name: 'shop_main-primary', running: 1 }, pooler });
    // The rotation rewrites the members' password secret and restarts the writer in place.
    const after = planPooler({ ...ref, declared: CONFIG, writer: { name: 'shop_main-primary', running: 1 }, pooler });
    expect(before).toEqual({ kind: 'steady' });
    expect(after).toEqual({ kind: 'steady' });
    expect(JSON.stringify(pooler.labels)).not.toContain('pg-password');
    expect(poolerSpec({ ...ref, config: CONFIG, target: 'shop_main-primary', authSecret: AUTH, image: 'i' }).secrets?.map((r) => r.source)).toEqual([AUTH]);
  });
});
