import { isPgMemoryMb, pgMemorySettings } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { data } from './data';

/**
 * Demo `db.setMemory` and the memory half of `db.get` (Postgres page, board
 * 39). Wraps data.ts's `db.get` (so it comes after it in the registry): each
 * cluster carries its declared memory, and each member the size it was last
 * restarted with. A change walks the reconcile's order on a clock: the
 * standby copies at ~4 s, the main copy at ~8 s. Seeded: checkout at 1 GB,
 * data/main at 2 GB.
 */

interface MemState { mb: number | null; prev: number | null; at: number }
type Mem = Record<string, MemState>;

const STEP_MS = 4_000;
const SEED: Mem = {
  'storefront/checkout': { mb: 1024, prev: 1024, at: 0 },
  'data/main': { mb: 2048, prev: 2048, at: 0 },
};

function state(s: DemoStore): Mem {
  s.extra.pgMemory ??= structuredClone(SEED);
  return s.extra.pgMemory as Mem;
}

interface Member { service: string; role: string; desired: number }
interface Cluster { name: string; members: Member[] }

function decorate(s: DemoStore, stack: string, c: Cluster): Cluster & { memoryMb?: number } {
  const m = state(s)[`${stack}/${c.name}`];
  if (!m) return c;
  const age = Date.now() - m.at;
  const at = (role: string): number | null => (age >= (role === 'primary' ? 2 : 1) * STEP_MS ? m.mb : m.prev);
  return {
    ...c,
    ...(m.mb !== null ? { memoryMb: m.mb } : {}),
    members: c.members.map((x) => {
      const mb = x.role === 'dcs' ? null : at(x.role);
      return mb === null ? x : { ...x, memoryMb: mb };
    }),
  };
}

const baseGet = data.handlers!['db.get']!;

export const pgMemoryDemo: DomainResolvers = {
  handlers: {
    'db.get': (i, s) => {
      const r = baseGet(i, s) as { stack: string; clusters: Cluster[] };
      return { ...r, clusters: r.clusters.map((c) => decorate(s, r.stack, c)) };
    },
    'db.setMemory': (i, s) => {
      const { stack, cluster, memoryMb } = i as { stack: string; cluster: string; memoryMb: number | null };
      if (memoryMb !== null && !isPgMemoryMb(memoryMb)) throw new Error('memory must be a whole number of MB between 256 and 262144');
      const key = `${stack}/${cluster}`;
      const st = state(s);
      const cur = st[key] ?? { mb: null, prev: null, at: 0 };
      const settled = Date.now() - cur.at >= 2 * STEP_MS ? cur.mb : cur.prev;
      const changed = cur.mb !== memoryMb;
      if (changed) st[key] = { mb: memoryMb, prev: settled, at: Date.now() };
      const r = (baseGet({ stack }, s) as { clusters: Cluster[] }).clusters.find((c) => c.name === cluster);
      const restarts = (r?.members ?? []).filter((m) => m.role !== 'dcs').reduce((n, m) => n + Math.max(1, m.desired), 0);
      const set = memoryMb === null ? null : pgMemorySettings(memoryMb);
      return { stack, cluster, memoryMb, changed, sharedBuffersMb: set?.sharedBuffersMb ?? null, effectiveCacheSizeMb: set?.effectiveCacheSizeMb ?? null, restarts };
    },
  },
};
