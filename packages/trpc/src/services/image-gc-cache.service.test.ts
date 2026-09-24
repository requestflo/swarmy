import { seedKv } from './swarm-kv.service';
import { describe, expect, it } from 'bun:test';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { runCacheGcForOrg } from './image-gc.service';

const GB = 1024 ** 3;
const now = new Date('2026-09-24T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

function fakes(opts: { sizes: Record<string, number | null> }) {
  const scripts: string[] = [];
  const cleared: string[][] = [];
  const hub = {
    managerNode: () => 'mgr',
    dispatch: async (_n: string, cmd: string, p: { cmd: string[]; networks: string[] }) => {
      expect(cmd).toBe('container.runOnce');
      expect(p.networks).toEqual(['host']);
      const script = p.cmd[0] ?? '';
      scripts.push(script);
      const out: string[] = [];
      for (const [ref, size] of Object.entries(opts.sizes)) {
        if (script.includes(`manifest get '${ref}'`)) out.push(`@@SWARMY-CACHE-SIZE@@ ${ref} ${size ?? '-'}`);
        if (script.includes(`tag delete '${ref}'`)) out.push(`@@SWARMY-CACHE-DELETED@@ ${ref}`);
      }
      return { exitCode: 0, output: out.join('\n') };
    },
  } as unknown as AgentHub;
  const db = {
    build: {
      groupBy: async () => [
        { cacheRef: 'localhost:5000/a:buildcache-root-main', _max: { finishedAt: daysAgo(1.5) } },
        { cacheRef: 'localhost:5000/a:buildcache-root-old-branch', _max: { finishedAt: daysAgo(40) } },
        { cacheRef: 'localhost:5000/b:buildcache-root-main', _max: { finishedAt: daysAgo(3) } },
        { cacheRef: 'localhost:5000/c:buildcache-root-main', _max: { finishedAt: daysAgo(2) } },
      ],
      updateMany: async (q: { where: { cacheRef: { in: string[] } } }) => {
        cleared.push(q.where.cacheRef.in);
        return { count: q.where.cacheRef.in.length };
      },
    },
  } as unknown as DB;
  // Registry + GC policy live in the org's swarm (swarm-kv).
  seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, host: 'localhost:5000', credentialsEnc: null });
  seedKv(hub, 'o1', 'image-gc', 'o1', { mode: 'ON_HEALTHCHECK', keepProd: true, days: null, cacheMaxAgeDays: 14, cacheMaxGb: 2 });
  return { deps: { db, hub, auth: {} as Auth }, scripts, cleared };
}

describe('runCacheGcForOrg (registry build cache: age/size policy)', () => {
  const sizes = {
    'localhost:5000/a:buildcache-root-main': 1 * GB,
    'localhost:5000/a:buildcache-root-old-branch': 1 * GB,
    'localhost:5000/b:buildcache-root-main': 1.5 * GB,
    'localhost:5000/c:buildcache-root-main': null,
  };

  it('deletes stale + over-budget cache tags, forgets missing ones', async () => {
    const f = fakes({ sizes });
    const r = await runCacheGcForOrg(f.deps, 'o1', { now });
    expect(r.removed).toEqual([
      { ref: 'localhost:5000/a:buildcache-root-old-branch', reason: 'age' },
      { ref: 'localhost:5000/c:buildcache-root-main', reason: 'missing' },
      { ref: 'localhost:5000/b:buildcache-root-main', reason: 'size' },
    ]);
    expect(r.deleted.sort()).toEqual(['localhost:5000/a:buildcache-root-old-branch', 'localhost:5000/b:buildcache-root-main']);
    expect(f.scripts).toHaveLength(2);
    expect(f.scripts[1]).not.toContain("tag delete 'localhost:5000/a:buildcache-root-main'");
    expect(f.cleared.flat().sort()).toEqual([
      'localhost:5000/a:buildcache-root-old-branch',
      'localhost:5000/b:buildcache-root-main',
      'localhost:5000/c:buildcache-root-main',
    ]);
  });

  it('dry run reads sizes but deletes nothing', async () => {
    const f = fakes({ sizes });
    const r = await runCacheGcForOrg(f.deps, 'o1', { now, dryRun: true });
    expect(r.removed).toHaveLength(3);
    expect(r.deleted).toEqual([]);
    expect(f.scripts).toHaveLength(1);
    expect(f.cleared).toEqual([]);
  });
});
