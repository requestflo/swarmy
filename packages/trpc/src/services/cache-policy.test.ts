import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POLICY_APPLIED_MARKER,
  appliedCachePolicy,
  declaredCachePolicy,
  defaultCachePolicy,
  encodeCachePolicy,
  parseCachePolicy,
  policyApplyScript,
  policyStartPrelude,
  queuePolicyRefusal,
} from './cache-policy';

describe('policy codec + defaults', () => {
  it('defaults to what every cache ran before: LRU (queues noeviction) with AOF', () => {
    expect(defaultCachePolicy()).toEqual({ eviction: 'allkeys-lru', persistence: 'aof' });
    expect(defaultCachePolicy('queue')).toEqual({ eviction: 'noeviction', persistence: 'aof' });
  });

  it('round-trips the applied label and rejects anything unknown', () => {
    const p = { eviction: 'volatile-lru' as const, persistence: 'rdb' as const };
    expect(parseCachePolicy(encodeCachePolicy(p))).toEqual(p);
    for (const bad of [undefined, '', 'lru/aof', 'allkeys-lru', 'allkeys-lru/disk']) expect(parseCachePolicy(bad)).toBeNull();
  });

  it('declared reads the two labels part by part; applied falls back to the purpose default', () => {
    expect(declaredCachePolicy({ 'swarmy.cache.persistence': 'off' })).toEqual({ eviction: 'allkeys-lru', persistence: 'off' });
    expect(declaredCachePolicy({ 'swarmy.cache.evictionPolicy': 'bogus' }, 'queue')).toEqual(defaultCachePolicy('queue'));
    expect(appliedCachePolicy({}, 'queue')).toEqual(defaultCachePolicy('queue'));
    expect(appliedCachePolicy({ 'swarmy.cache.appliedPolicy': 'noeviction/off' })).toEqual({ eviction: 'noeviction', persistence: 'off' });
  });

  it('a queue store keeps noeviction', () => {
    expect(queuePolicyRefusal('queue', 'allkeys-lru')).toContain('noeviction');
    expect(queuePolicyRefusal('queue', 'noeviction')).toBeNull();
    expect(queuePolicyRefusal('cache', 'volatile-lru')).toBeNull();
  });
});

/** Run the start prelude in a real `sh`, as the server task would. */
function prelude(env: string | undefined, fallback = defaultCachePolicy()): string {
  const r = Bun.spawnSync(['sh', '-c', `${policyStartPrelude(fallback)}\nprintf '%s|%s|%s' "$E" "$A" "$S"`], {
    env: env === undefined ? {} : { SWARMY_CACHE_POLICY: env },
  });
  return r.stdout.toString();
}

describe('policyStartPrelude — a (re)started task reads its applied policy, never fails on a bad one', () => {
  it('maps each persistence mode to appendonly + save', () => {
    expect(prelude('volatile-lru/rdb')).toBe('volatile-lru|no|3600 1 300 100 60 10000');
    expect(prelude('noeviction/off')).toBe('noeviction|no|');
    expect(prelude('allkeys-lru/aof')).toBe('allkeys-lru|yes|3600 1 300 100 60 10000');
  });

  it('missing, unexpanded or garbage values fall back to the baked-in policy', () => {
    const fb = { eviction: 'noeviction' as const, persistence: 'off' as const };
    expect(prelude(undefined, fb)).toBe('noeviction|no|');
    expect(prelude('{{index .Service.Labels "swarmy.cache.appliedPolicy"}}', fb)).toBe('noeviction|no|');
    expect(prelude('allkeys-lru/disk', fb)).toBe('allkeys-lru|no|');
    expect(prelude('$(reboot)/aof', fb)).toBe('noeviction|yes|3600 1 300 100 60 10000');
    expect(prelude('rm -rf /;/aof', fb)).toBe('noeviction|no|');
  });
});

/** A fake valkey-cli on PATH: logs its args, answers CONFIG SET / INFO / BGSAVE. */
function fakeCli(info: string, configReply = 'OK'): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-cache-policy-'));
  const log = join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `shift 3; echo "$*" >> ${log}`,
    `case "$1" in CONFIG) echo "${configReply}";; INFO) printf '%s\\r\\n' ${info.split('\n').map((l) => `'${l}'`).join(' ')};; *) echo OK;; esac`,
  ].join('\n');
  writeFileSync(join(dir, 'valkey-cli'), script);
  chmodSync(join(dir, 'valkey-cli'), 0o755);
  return { dir, log };
}

function apply(target: Parameters<typeof policyApplyScript>[1], cli: { dir: string }): { out: string; code: number } {
  const r = Bun.spawnSync(['sh', '-c', policyApplyScript('valkey', target)], { env: { PATH: `${cli.dir}:/usr/bin:/bin` } });
  return { out: r.stdout.toString(), code: r.exitCode };
}

describe('policyApplyScript — CONFIG SET live, wait until it is on disk, then the marker', () => {
  const idle = 'aof_rewrite_in_progress:0\naof_rewrite_scheduled:0\nrdb_bgsave_in_progress:0\naof_last_bgrewrite_status:ok';

  it('to AOF: one atomic CONFIG SET, no BGSAVE, marker once the rewrite is done', () => {
    const cli = fakeCli(idle);
    const r = apply({ eviction: 'allkeys-lru', persistence: 'aof' }, cli);
    expect(r).toEqual({ out: `${POLICY_APPLIED_MARKER}\n`, code: 0 });
    const calls = readFileSync(cli.log, 'utf8');
    expect(calls).toContain('CONFIG SET maxmemory-policy allkeys-lru appendonly yes save 3600 1 300 100 60 10000');
    expect(calls).not.toContain('BGSAVE');
  }, 30_000);

  it('leaving AOF snapshots first, so a restart right after keeps the data', () => {
    const cli = fakeCli(idle);
    expect(apply({ eviction: 'noeviction', persistence: 'off' }, cli).code).toBe(0);
    const calls = readFileSync(cli.log, 'utf8');
    expect(calls).toContain('CONFIG SET maxmemory-policy noeviction appendonly no save ');
    expect(calls).toContain('BGSAVE');
  }, 30_000);

  it('no marker when CONFIG SET is refused or the AOF rewrite failed', () => {
    expect(apply({ eviction: 'allkeys-lru', persistence: 'aof' }, fakeCli(idle, 'ERR unknown option')).out).not.toContain(POLICY_APPLIED_MARKER);
    const failed = fakeCli(idle.replace('aof_last_bgrewrite_status:ok', 'aof_last_bgrewrite_status:err'));
    const r = apply({ eviction: 'allkeys-lru', persistence: 'aof' }, failed);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(POLICY_APPLIED_MARKER);
  }, 30_000);
});
