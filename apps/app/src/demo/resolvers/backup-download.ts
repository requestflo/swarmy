import { DEFAULT_DOWNLOAD_MAX_BYTES, checkSnapshotPath, downloadFileName } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's "Download a file or folder…" (board 16): a made-up tree per
 * kind of volume to browse, and a ticket that names the .tar.gz it would be.
 * The demo has no controller and no agent to stream from, so nothing
 * downloads; the sheet says so. `downloadStatus` stays empty.
 */

type Entry = { name: string; type: 'file' | 'dir'; size?: number };

const TREES: Array<[RegExp, Record<string, Entry[]>]> = [
  [/postgres|pg/, {
    '': [{ name: 'pgdata', type: 'dir' }],
    pgdata: [{ name: 'base', type: 'dir' }, { name: 'pg_wal', type: 'dir' }, { name: 'postgresql.conf', type: 'file', size: 29_830 }, { name: 'pg_hba.conf', type: 'file', size: 5_711 }, { name: 'PG_VERSION', type: 'file', size: 3 }],
    'pgdata/base': [{ name: '16384', type: 'dir' }, { name: '1', type: 'dir' }],
    'pgdata/pg_wal': [{ name: '000000010000000000000042', type: 'file', size: 16_777_216 }],
  }],
  [/redis|valkey|cache/, { '': [{ name: 'dump.rdb', type: 'file', size: 94_371_840 }, { name: 'appendonly.aof', type: 'file', size: 3_145_728_000 }] }],
  [/grafana/, {
    '': [{ name: 'grafana.db', type: 'file', size: 307_232_768 }, { name: 'plugins', type: 'dir' }, { name: 'png', type: 'dir' }],
    plugins: [{ name: 'grafana-clock-panel', type: 'dir' }],
  }],
  [/.*/, {
    '': [{ name: 'uploads', type: 'dir' }, { name: 'config', type: 'dir' }, { name: 'README.txt', type: 'file', size: 812 }],
    uploads: [{ name: '2026', type: 'dir' }, { name: 'logo.png', type: 'file', size: 48_211 }],
    'uploads/2026': [{ name: 'invoice-1042.pdf', type: 'file', size: 182_004 }, { name: 'invoice-1043.pdf', type: 'file', size: 179_330 }],
    config: [{ name: 'app.yml', type: 'file', size: 2_310 }, { name: 'secrets.env', type: 'file', size: 402 }],
  }],
];

interface Snap { id: string; volume: string; startedAt: string }

function snapOf(s: DemoStore, id: string): Snap {
  const snaps = (s.extra.data as { snapshots: Snap[] } | undefined)?.snapshots ?? [];
  const snap = snaps.find((x) => x.id === id);
  if (!snap) throw new Error(`snapshot "${id}" not found`);
  return snap;
}

function treeFor(volume: string): Record<string, Entry[]> {
  return (TREES.find(([re]) => re.test(volume)) ?? TREES[TREES.length - 1]!)[1];
}

function view(path: string, e: Entry) {
  const rel = path ? `${path}/${e.name}` : e.name;
  return { path: rel, name: e.name, type: e.type, sizeBytes: e.size != null ? String(e.size) : null, mtime: null };
}

/** The node at `rel` in the tree: a folder when it has a listing, else the file in its parent. */
function nodeAt(tree: Record<string, Entry[]>, rel: string) {
  if (tree[rel]) return { path: rel, name: rel.split('/').pop() || 'data', type: 'dir' as const, sizeBytes: null, mtime: null };
  const parent = rel.split('/').slice(0, -1).join('/');
  const hit = tree[parent]?.find((e) => (parent ? `${parent}/${e.name}` : e.name) === rel && e.type === 'file');
  return hit ? view(parent, hit) : null;
}

function parsePath(raw: unknown): string {
  const p = checkSnapshotPath(typeof raw === 'string' ? raw : '');
  if (!p.ok) throw new Error(p.reason);
  return p.rel;
}

export const backupDownload: DomainResolvers = {
  handlers: {
    'backups.browseSnapshot': (i, s) => {
      const b = i as { snapshotId: string; path?: string };
      const tree = treeFor(snapOf(s, b.snapshotId).volume);
      const rel = parsePath(b.path);
      const node = nodeAt(tree, rel);
      const entries = node?.type === 'dir' ? (tree[rel] ?? []).map((e) => view(rel, e)) : [];
      return { path: rel, node, entries, truncated: false, maxBytes: String(DEFAULT_DOWNLOAD_MAX_BYTES) };
    },
    'backups.downloadTicket': (i, s) => {
      const b = i as { snapshotId: string; path?: string };
      const snap = snapOf(s, b.snapshotId);
      const rel = parsePath(b.path);
      const node = nodeAt(treeFor(snap.volume), rel);
      if (!node) throw new Error(`This save has nothing at “${rel}”.`);
      const size = node.sizeBytes != null ? Number(node.sizeBytes) : null;
      if (size != null && size > DEFAULT_DOWNLOAD_MAX_BYTES) throw new Error('It’s past the 2 GB download limit. Restore the save into a new volume instead.');
      return {
        downloadId: crypto.randomUUID(),
        url: '',
        fileName: downloadFileName({ volume: snap.volume, rel, savedAt: new Date(snap.startedAt) }),
        kind: node.type,
        sizeBytes: node.sizeBytes,
        maxBytes: String(DEFAULT_DOWNLOAD_MAX_BYTES),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    },
    'backups.downloadStatus': () => null,
  },
};
