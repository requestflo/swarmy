import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DB_MEMORY_APPLIED_LABEL,
  applyPgMemory,
  parseMemoryMb,
  parsePgSizeMb,
  pgMemoryCarry,
  primaryDeclarations,
  pgMemorySettings,
} from './manageddb-memory';
import { pgBootScript, pgMemoryLines } from './manageddb-pg';
import { applyPgMember } from './manageddb-storage';

describe('pgMemorySettings — 25% / 75% of the limit', () => {
  it('sizes shared_buffers and effective_cache_size from the limit', () => {
    expect(pgMemorySettings(2048)).toEqual({ memoryMb: 2048, memoryBytes: 2048 * 1024 * 1024, sharedBuffersMb: 512, effectiveCacheSizeMb: 1536 });
    expect(pgMemorySettings(1000)).toMatchObject({ sharedBuffersMb: 250, effectiveCacheSizeMb: 750 });
    expect(pgMemorySettings(257)).toMatchObject({ sharedBuffersMb: 64, effectiveCacheSizeMb: 192 });
  });
});

describe('parseMemoryMb', () => {
  it('takes only a whole number of MB in range', () => {
    expect(parseMemoryMb('1024')).toBe(1024);
    expect([parseMemoryMb(undefined), parseMemoryMb(''), parseMemoryMb('1.5'), parseMemoryMb('128'), parseMemoryMb('1g')]).toEqual([null, null, null, null, null]);
  });
});

describe('applyPgMemory — the applied label is the whole truth', () => {
  type Spec = { env?: Record<string, string>; resources?: { limits?: { cpus?: number; memoryBytes?: number } } };
  it('sets the limit and the boot env from the applied label', () => {
    const s = applyPgMemory<Spec>({ env: { A: '1' } }, { [DB_MEMORY_APPLIED_LABEL]: '1024' });
    expect(s.env).toEqual({ A: '1', SWARMY_PG_SHARED_BUFFERS: '256MB', SWARMY_PG_EFFECTIVE_CACHE_SIZE: '768MB' });
    expect(s.resources).toEqual({ limits: { memoryBytes: 1024 * 1024 * 1024 } });
  });

  it('no label: the settings and the limit come off a member rebuilt from live env', () => {
    const s = applyPgMemory<Spec>(
      { env: { A: '1', SWARMY_PG_SHARED_BUFFERS: '256MB', SWARMY_PG_EFFECTIVE_CACHE_SIZE: '768MB' }, resources: { limits: { cpus: 1, memoryBytes: 5 } } },
      {},
    );
    expect(s.env).toEqual({ A: '1' });
    expect(s.resources).toEqual({ limits: { cpus: 1 } });
  });

  it('runs inside applyPgMember, so every member rebuild keeps it', () => {
    const labels = { [DB_MEMORY_APPLIED_LABEL]: '512' };
    const s = applyPgMember<{ env?: Record<string, string>; labels?: Record<string, string>; resources?: { limits?: { memoryBytes?: number } } }>({ env: {}, labels }, labels);
    expect(s.env?.SWARMY_PG_SHARED_BUFFERS).toBe('128MB');
    expect(s.resources?.limits?.memoryBytes).toBe(512 * 1024 * 1024);
  });

  it('a fresh member starts at the declared memory', () => {
    expect(pgMemoryCarry({ 'swarmy.db.memoryMb': '2048' })).toEqual({ [DB_MEMORY_APPLIED_LABEL]: '2048' });
    expect(pgMemoryCarry({})).toEqual({});
  });
});

describe('primaryDeclarations — what a promoted writer inherits', () => {
  it('carries the memory and extension declarations, nothing else', () => {
    expect(primaryDeclarations({ 'swarmy.db.memoryMb': '2048', 'swarmy.db.extensions': 'pg_stat_statements', 'swarmy.db.extensions.applied': 'pg_stat_statements', 'swarmy.db.role': 'primary', 'swarmy.db.memoryMb.applied': '2048' })).toEqual({
      'swarmy.db.memoryMb': '2048', 'swarmy.db.extensions': 'pg_stat_statements', 'swarmy.db.extensions.applied': 'pg_stat_statements',
    });
    expect(primaryDeclarations(undefined)).toEqual({});
  });
});

describe('parsePgSizeMb (SHOW shared_buffers)', () => {
  it('reads every unit Postgres prints', () => {
    expect([parsePgSizeMb('256MB'), parsePgSizeMb('1GB\n'), parsePgSizeMb('16384kB'), parsePgSizeMb('nope')]).toEqual([256, 1024, 16, null]);
  });
});

describe('boot layer — the memory env → a conf the server includes', () => {
  const run = (env: Record<string, string>) => {
    const conf = join(mkdtempSync(join(tmpdir(), 'swarmy-mem-')), 'swarmy-memory.conf');
    Bun.spawnSync(['sh', '-c', pgMemoryLines(conf).join('\n')], { env: { PATH: process.env.PATH ?? '', ...env } });
    return existsSync(conf) ? readFileSync(conf, 'utf8') : null;
  };
  it('writes both settings on start', () => {
    expect(run({ SWARMY_PG_SHARED_BUFFERS: '256MB', SWARMY_PG_EFFECTIVE_CACHE_SIZE: '768MB' })).toBe(
      "shared_buffers = '256MB'\neffective_cache_size = '768MB'\n",
    );
  });
  it('writes nothing without them, and ignores anything but <n>MB', () => {
    expect(run({})).toBeNull();
    expect(run({ SWARMY_PG_SHARED_BUFFERS: "1'; x", SWARMY_PG_EFFECTIVE_CACHE_SIZE: 'MB' })).toBeNull();
    expect(run({ SWARMY_PG_SHARED_BUFFERS: '1M2MB' })).toBeNull();
  });
  it('the entrypoint writes it before handing off to the official one', () => {
    const s = pgBootScript();
    expect(s.indexOf('SWARMY_PG_SHARED_BUFFERS')).toBeGreaterThan(0);
    expect(s.indexOf('SWARMY_PG_SHARED_BUFFERS')).toBeLessThan(s.indexOf('exec docker-entrypoint.sh postgres'));
  });
});
