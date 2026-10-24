import type { DemoStore, DomainResolvers } from '../types';

/**
 * Cluster config versions demo (swarm-kv): a handful of documents in the
 * Northwind swarm's raft, three versions of the backup destination, and a
 * working "Put back vN". Mirrors KvDocsView / KvDocVersionView / KvRevertResult
 * (packages/trpc/src/services/swarm-kv-versions.service.ts).
 */
interface DemoVersion {
  seq: number;
  updatedAt: string;
  bytes: number;
  /** Fields that differ from the current version. */
  changes: string[];
}
interface DemoDoc {
  collection: string;
  id: string;
  name: string | null;
  versions: DemoVersion[]; // newest first
}

const ago = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const ORG = 'org-demo';

function seed(): DemoDoc[] {
  const doc = (collection: string, id: string, name: string | null, vs: Array<[number, number, string[]]>): DemoDoc => ({
    collection,
    id,
    name,
    versions: vs.map(([seq, h, changes], i) => ({ seq, updatedAt: ago(h), bytes: 1_400 + seq * 37 + i * 11, changes })),
  });
  return [
    doc('bkp-target', 'cm2offsite0000000000000001', 'offsite', [[3, 2, []], [2, 30, ['enabled']], [1, 200, ['bucket', 'enabled']]]),
    doc('bkp-sched', 'cm2sched000000000000000001', 'shop_db-data', [[2, 50, []], [1, 400, ['every']]]),
    doc('ctl-backup', 'controller', null, [[1, 600, []]]),
    doc('ingress', ORG, null, [[4, 5, []], [3, 72, ['targetNodes']], [2, 300, ['driver', 'targetNodes']]]),
    doc('mesh', ORG, null, [[1, 900, []]]),
    doc('stack', 'cm2stackshop00000000000001', 'shop', [[6, 1, []], [5, 26, ['compose']], [4, 98, ['compose', 'env']]]),
  ];
}

function docs(store: DemoStore): DemoDoc[] {
  return (store.extra.swarmKv ??= seed()) as DemoDoc[];
}

const find = (store: DemoStore, i: unknown): DemoDoc | undefined => {
  const { collection, id } = i as { collection: string; id: string };
  return docs(store).find((d) => d.collection === collection && d.id === id);
};

export const swarmkv: DomainResolvers = {
  handlers: {
    'swarmKv.list': (_i, store) => {
      const all = docs(store);
      return {
        available: true,
        reason: null,
        footprintBytes: all.reduce((n, d) => n + d.versions.reduce((m, v) => m + v.bytes, 0), 0),
        maxDocBytes: 64 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
        keepVersions: 3,
        docs: all.map((d) => ({ ...d, ...d.versions[0]!, versions: d.versions.map(({ changes: _c, ...v }) => v) })),
      };
    },
    'swarmKv.versions': (i, store) =>
      (find(store, i)?.versions ?? []).map((v, idx) => ({ ...v, current: idx === 0, changes: idx === 0 ? [] : v.changes })),
    'swarmKv.revert': (i, store) => {
      const d = find(store, i);
      const seq = (i as { seq: number }).seq;
      const from = d?.versions.find((v) => v.seq === seq);
      if (!d || !from) throw new Error(`v${seq} is no longer kept (swarmy keeps the last 3)`);
      const next = d.versions[0]!.seq + 1;
      const current = d.versions[0]!;
      // A new version on top (oldest pruned to 3 kept); the old current now differs by what the put-back
      // changed, and the version put back matches the new current.
      const rest = d.versions.slice(1).map((v) => (v.seq === seq ? { ...v, changes: [] } : v));
      const top = { seq: next, updatedAt: new Date().toISOString(), bytes: from.bytes, changes: [] };
      d.versions = [top, { ...current, changes: from.changes }, ...rest].slice(0, 3);
      return { collection: d.collection, id: d.id, restoredFrom: seq, seq: next, changed: true };
    },
  },
};
