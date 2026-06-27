import { describe, expect, test } from 'bun:test';
import { resolveDbDriver, buildAdapter } from './client';
import { PrismaPGlite } from './pglite-adapter';

describe('resolveDbDriver', () => {
  test('defaults to postgres for back-compat', () => {
    expect(resolveDbDriver({})).toBe('postgres');
    expect(resolveDbDriver({ DATABASE_URL: 'postgresql://u:p@h/db' })).toBe('postgres');
  });

  test('honours explicit SWARMY_DB_DRIVER', () => {
    expect(resolveDbDriver({ SWARMY_DB_DRIVER: 'pglite' })).toBe('pglite');
    expect(resolveDbDriver({ SWARMY_DB_DRIVER: 'PostgreS' })).toBe('postgres');
    expect(resolveDbDriver({ SWARMY_DB_DRIVER: 'PGLITE' })).toBe('pglite');
  });

  test('infers pglite from the DATABASE_URL scheme', () => {
    expect(resolveDbDriver({ DATABASE_URL: 'file:/var/lib/swarmy/pg' })).toBe('pglite');
    expect(resolveDbDriver({ DATABASE_URL: 'pglite:///data' })).toBe('pglite');
    expect(resolveDbDriver({ DATABASE_URL: 'memory://' })).toBe('pglite');
  });

  test('explicit driver wins over an inferred scheme', () => {
    expect(resolveDbDriver({ SWARMY_DB_DRIVER: 'postgres', DATABASE_URL: 'file:/x' })).toBe(
      'postgres',
    );
  });
});

describe('buildAdapter', () => {
  test('pglite mode returns a PGlite factory (no DATABASE_URL required)', () => {
    const a = buildAdapter({ SWARMY_DB_DRIVER: 'pglite' });
    expect(a).toBeInstanceOf(PrismaPGlite);
    expect(a.provider).toBe('postgres');
  });

  test('postgres mode without DATABASE_URL throws a helpful error', () => {
    expect(() => buildAdapter({ SWARMY_DB_DRIVER: 'postgres' })).toThrow(/DATABASE_URL/);
  });

  test('postgres mode builds a pg adapter when DATABASE_URL is set', () => {
    const a = buildAdapter({
      SWARMY_DB_DRIVER: 'postgres',
      DATABASE_URL: 'postgresql://u:p@localhost/db',
    });
    expect(a.provider).toBe('postgres');
    expect(a).not.toBeInstanceOf(PrismaPGlite);
  });
});
