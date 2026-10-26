import { describe, expect, it } from 'bun:test';
import { nextAuthSecret, planPooler, type PoolerPlanInput } from './manageddb-pooler-plan';
import { poolerImageOf, poolerSignature, poolerSpec, type PoolerSpecInput } from './manageddb-pooler-spec';

/** The pooler's spec and the reconcile's per-tick decision about it. */

const IMAGE = 'edoburu/pgbouncer:v1.26.1-p0';
const AUTH = 'shop_main-pg-pooler__v1';
const input: PoolerSpecInput = {
  stack: 'shop',
  cluster: 'main',
  config: { mode: 'transaction', poolSize: 20 },
  target: 'shop_main-primary',
  authSecret: AUTH,
  image: IMAGE,
};
const live = (over: Partial<PoolerSpecInput> = {}) => {
  const s = poolerSpec({ ...input, ...over });
  return { name: s.name, image: `${s.image}@sha256:${'a'.repeat(64)}`, labels: s.labels! };
};
const plan = (over: Partial<PoolerPlanInput>) =>
  planPooler({ stack: 'shop', cluster: 'main', declared: input.config, writer: { name: 'shop_main-primary', running: 1 }, ...over });

describe('poolerSpec', () => {
  it('one PgBouncer task on the cluster overlay, no published port, its auth secret as a file, health-checked, start-first', () => {
    const s = poolerSpec(input);
    expect(s.name).toBe('shop_main-pooler');
    expect(s.image).toBe(IMAGE);
    expect(s.networks).toEqual(['shop_main-net']);
    expect(s.ports).toBeUndefined();
    expect(s.secrets).toEqual([{ source: AUTH, target: 'shop_main-pg-pooler' }]);
    expect(s.env).toMatchObject({
      SWARMY_POOLER_HOST: 'shop_main-primary',
      SWARMY_POOLER_MODE: 'transaction',
      SWARMY_POOLER_POOL_SIZE: '20',
      SWARMY_POOLER_AUTH_FILE: '/run/secrets/shop_main-pg-pooler',
    });
    expect(s.command?.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(s.healthcheck?.test?.[1]).toBe('pg_isready');
    expect(s.updateConfig).toEqual({ parallelism: 1, order: 'start-first' });
    expect(s.stopGracePeriodNs).toBe(20_000_000_000);
    expect(s.labels).toMatchObject({
      'swarmy.db.cluster': 'main',
      'swarmy.db.role': 'pooler',
      'swarmy.scaleToZero.exempt': 'true',
      'swarmy.db.pooler.target': 'shop_main-primary',
      'swarmy.db.pooler.auth': AUTH,
      'swarmy.db.pooler.sig': poolerSignature(input),
    });
    // Not a Postgres member: nothing that reads members by engine sees it.
    expect(s.labels?.['swarmy.db.engine']).toBeUndefined();
  });

  it('the signature moves with every input and only with them', () => {
    const sig = poolerSignature(input);
    expect(poolerSignature({ ...input })).toBe(sig);
    for (const over of [{ target: 'shop_main-replica' }, { config: { mode: 'session' as const, poolSize: 20 } }, { config: { mode: 'transaction' as const, poolSize: 21 } }, { authSecret: 'shop_main-pg-pooler__v2' }, { image: 'edoburu/pgbouncer:v1.27.0-p0' }]) {
      expect(poolerSignature({ ...input, ...over })).not.toBe(sig);
    }
  });

  it('keeps the live image (digest dropped), the BOM ref when there is none', () => {
    expect(poolerImageOf(undefined)).toBe(IMAGE);
    expect(poolerImageOf(`${IMAGE}@sha256:${'b'.repeat(64)}`)).toBe(IMAGE);
    expect(poolerImageOf(`localhost:5000/swarmy-system/docker.io/edoburu/pgbouncer:v1.26.1-p0@sha256:${'b'.repeat(64)}`)).toBe(IMAGE);
    expect(poolerImageOf('edoburu/pgbouncer:v1.25.2-p0@sha256:c')).toBe('edoburu/pgbouncer:v1.25.2-p0');
  });
});

describe('planPooler', () => {
  it('off: nothing, or the pooler and its auth secret go', () => {
    expect(plan({ declared: null })).toEqual({ kind: 'steady' });
    expect(plan({ declared: null, pooler: live() })).toEqual({ kind: 'remove', service: 'shop_main-pooler', authSecret: AUTH });
  });

  it('on with no pooler: create it, minting its login on the running writer first', () => {
    expect(plan({})).toEqual({ kind: 'deploy', create: true, config: input.config, target: 'shop_main-primary', image: IMAGE, authSecret: null, from: null });
    expect(plan({ writer: { name: 'shop_main-primary', running: 0 } }).kind).toBe('wait');
    expect(plan({ writer: undefined }).kind).toBe('wait');
  });

  it('steady state sends nothing: the stamped signature matches what the labels say', () => {
    expect(plan({ pooler: live() })).toEqual({ kind: 'steady' });
    // A writer outage alone changes nothing: it stays pointed where it is.
    expect(plan({ pooler: live(), writer: { name: 'shop_main-primary', running: 0 } })).toEqual({ kind: 'steady' });
  });

  it('a new mode, pool size or writer redeploys it with its existing login', () => {
    const p = plan({ pooler: live(), declared: { mode: 'session', poolSize: 40 } });
    expect(p).toMatchObject({ kind: 'deploy', create: false, authSecret: AUTH, from: 'shop_main-primary', config: { mode: 'session', poolSize: 40 } });
    expect(plan({ pooler: live(), writer: { name: 'shop_main-replica', running: 1 } })).toMatchObject({ kind: 'deploy', target: 'shop_main-replica', from: 'shop_main-primary' });
  });

  it('mints one version past every version Docker still lists', () => {
    expect(nextAuthSecret('shop_main-pg-pooler', [])).toEqual({ name: 'shop_main-pg-pooler__v1', stale: [] });
    expect(nextAuthSecret('shop_main-pg-pooler', ['shop_main-pg-pooler__v2', 'shop_main-pg-password__v9', 'shop_main-pg-pooler__v1'])).toEqual({
      name: 'shop_main-pg-pooler__v3',
      stale: ['shop_main-pg-pooler__v1', 'shop_main-pg-pooler__v2'],
    });
  });
});
