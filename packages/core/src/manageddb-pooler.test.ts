import { describe, expect, it } from 'bun:test';
import { dataImage, engineImages } from './data-images';
import {
  POOLER_DEFAULT,
  POOLER_POOL_MAX,
  encodePoolerConfig,
  parsePoolerConfig,
  poolerServiceName,
  samePoolerConfig,
} from './manageddb-pooler';

describe('swarmy.db.pooler (the cluster declares its pooler)', () => {
  it('round-trips a declaration in a fixed key order', () => {
    const raw = encodePoolerConfig({ poolSize: 25, mode: 'session' } as never);
    expect(raw).toBe('{"mode":"session","poolSize":25}');
    expect(parsePoolerConfig(raw)).toEqual({ mode: 'session', poolSize: 25 });
    expect(parsePoolerConfig(encodePoolerConfig(POOLER_DEFAULT))).toEqual({ mode: 'transaction', poolSize: 20 });
  });

  it('absent or anything swarmy would not write is off', () => {
    for (const raw of [undefined, '', 'on', '{}', '{"mode":"statement","poolSize":20}', '{"mode":"session","poolSize":0}', `{"mode":"session","poolSize":${POOLER_POOL_MAX + 1}}`, '{"mode":"session","poolSize":2.5}', 'null']) {
      expect(parsePoolerConfig(raw)).toBeNull();
    }
  });

  it('compares declarations by value', () => {
    expect(samePoolerConfig(null, null)).toBe(true);
    expect(samePoolerConfig({ mode: 'session', poolSize: 5 }, { mode: 'session', poolSize: 5 })).toBe(true);
    expect(samePoolerConfig({ mode: 'session', poolSize: 5 }, null)).toBe(false);
    expect(samePoolerConfig({ mode: 'session', poolSize: 5 }, { mode: 'transaction', poolSize: 5 })).toBe(false);
  });

  it('names the service after the cluster', () => {
    expect(poolerServiceName('shop', 'main')).toBe('shop_main-pooler');
  });
});

describe('the pooler image is a BOM data entry', () => {
  it('PgBouncer is pinned by tag and digest, serves every Postgres major, and is not an engine', () => {
    const img = dataImage('pgbouncer');
    expect(img.ref).toBe('edoburu/pgbouncer:v1.26.1-p0');
    expect(img.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(img.role).toBe('pooler');
    expect(img.majors).toEqual(['14', '15', '16', '17']);
    expect(engineImages('postgres').map((i) => i.key)).not.toContain('pgbouncer');
  });
});
