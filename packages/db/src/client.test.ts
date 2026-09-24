import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildAdapter, DEV_DATA_DIR, resolveDbPaths } from './client';
import { PrismaBunSqlite } from './bun-sqlite-adapter';

describe('resolveDbPaths', () => {
  test('SWARMY_DATA_DIR holds control.db and telemetry.db', () => {
    expect(resolveDbPaths({ SWARMY_DATA_DIR: '/var/lib/swarmy/data' })).toEqual({
      control: '/var/lib/swarmy/data/control.db',
      telemetry: '/var/lib/swarmy/data/telemetry.db',
    });
  });

  test('explicit paths win, file: URLs and :memory: are accepted', () => {
    expect(
      resolveDbPaths({ SWARMY_DATA_DIR: '/d', SWARMY_DB_PATH: 'file:/x/c.db', SWARMY_TELEMETRY_DB_PATH: ':memory:' }),
    ).toEqual({ control: '/x/c.db', telemetry: ':memory:' });
  });

  test('defaults to <repo>/.swarmy/data for local dev', () => {
    expect(resolveDbPaths({}).control).toBe(join(DEV_DATA_DIR, 'control.db'));
    expect(DEV_DATA_DIR.endsWith(join('.swarmy', 'data'))).toBe(true);
  });
});

describe('buildAdapter', () => {
  test('returns a sqlite factory, one per file', () => {
    const env = { SWARMY_DB_PATH: '/tmp/swarmy-adapter-test/control.db' };
    const a = buildAdapter(env);
    expect(a).toBeInstanceOf(PrismaBunSqlite);
    expect(a.provider).toBe('sqlite');
    // boot-time ensureSchema and the app's PrismaClient share one handle.
    expect(buildAdapter(env)).toBe(a);
  });

  test('in-memory factories stay private', () => {
    const env = { SWARMY_DB_PATH: ':memory:' };
    expect(buildAdapter(env)).not.toBe(buildAdapter(env));
  });
});
