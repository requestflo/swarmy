import { describe, expect, test } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { swarmKvSizeSignal } from './resilience.swarm-kv';
import { swarmKvFor, useMemoryKv } from './swarm-kv.service';
import { createKvSizeWatch } from './swarm-kv-size-watch';

function world() {
  const hub = { managerNode: () => 'mgr-1' } as unknown as AgentHub;
  useMemoryKv(hub);
  const db = { organization: { findMany: async () => [{ id: 'org1' }] } } as unknown as DB;
  const lines: string[] = [];
  let t = 0;
  const watch = createKvSizeWatch({ hub, db }, { log: (l) => lines.push(`log ${l}`), warn: (l) => lines.push(`warn ${l}`), everyMs: 1_000, now: () => t });
  return { hub, kv: swarmKvFor(hub, 'org1'), watch, lines, tick: (ms: number) => (t += ms) };
}

/** ~77% of the 64 KB per-document limit once stored (base64). */
const BIG = { compose: 'x'.repeat(38_000) };

describe('swarm-kv size watch (log + Resilience)', () => {
  test('a document past 75% of its limit is logged once, then again only when it changes', async () => {
    const w = world();
    await w.kv.put('stack', 'shop', BIG);
    const [first] = await w.watch.tick();
    expect(first?.warnings.map((x) => [x.scope, x.collection, x.id, x.severity])).toEqual([['document', 'stack', 'shop', 'warn']]);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toMatch(/^warn \[swarm-kv\] org org1: document stack\/shop is \d+\.\d KB of its 64\.0 KB limit \(7\d%\)$/);
    w.tick(1_500);
    expect(await w.watch.tick()).toEqual([]); // same picture: nothing logged
    await w.kv.put('stack', 'shop', { compose: 'small' });
    w.tick(1_500);
    await w.watch.tick();
    expect(w.lines.at(-1)).toBe('log [swarm-kv] org org1: config sizes are back under 75% of their limits');
  });

  test('an org whose store is not loaded yet is left to the warm-up', async () => {
    const w = world();
    expect(await w.watch.tick()).toEqual([]);
    expect(w.kv.loaded).toBe(false);
  });

  test('Resilience reads the same warnings off the store', async () => {
    const w = world();
    await w.kv.put('stack', 'shop', BIG);
    const ctx = { hub: w.hub, activeOrgId: 'org1' } as unknown as OrgContext;
    expect((await swarmKvSizeSignal(ctx))?.warnings.map((x) => `${x.collection}/${x.id}`)).toEqual(['stack/shop']);
    const offline = { hub: { managerNode: () => undefined }, activeOrgId: 'org2' } as unknown as OrgContext;
    expect(await swarmKvSizeSignal(offline)).toBeUndefined(); // can't read the swarm: no signal, not "fine"
  });
});
