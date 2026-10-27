import { beforeEach, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { SnapshotLsResult } from '@swarmy/core/protocol';
import type { DownloadClaims } from '../hub/types';
import { browseSnapshot, mintSnapshotDownload, snapshotDownloadStatus } from './backupDownload.service';
import { seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-backup-download';

const SAVED = { id: 'snap1', orgId: 'org1', targetId: 't1', volume: 'shop_uploads', status: 'SUCCEEDED', resticId: 'abc123', hostNodeId: 'n1', startedAt: new Date('2026-10-27T03:00:00Z') };
const LS: Record<string, SnapshotLsResult> = {
  '/data': { node: { path: '/data', name: 'data', type: 'dir' }, entries: [{ path: '/data/img', name: 'img', type: 'dir' }, { path: '/data/a.txt', name: 'a.txt', type: 'file', size: 6 }], truncated: false },
  '/data/a.txt': { node: { path: '/data/a.txt', name: 'a.txt', type: 'file', size: 6, mtime: '2026-10-26T10:00:00Z' }, entries: [], truncated: false },
  '/data/huge.bin': { node: { path: '/data/huge.bin', name: 'huge.bin', type: 'file', size: 3 * 1024 ** 3 }, entries: [], truncated: false },
  '/data/link': { node: { path: '/data/link', name: 'link', type: 'symlink' }, entries: [], truncated: false },
};

let audit: Array<{ action: string; metadata?: unknown }>;
let minted: DownloadClaims[];
let dispatched: unknown[];

function ctx(over: { snapshot?: object | null; caps?: string[]; mint?: boolean; user?: string } = {}) {
  const hub = {
    liveInventory: () => ({ services: [], containers: [] }),
    isOnline: () => true,
    managerNodes: () => ['m1'],
    agentBuildFor: () => ({ version: '1', capabilities: over.caps ?? ['snapshotLs', 'snapshotDump'] }),
    dispatch: async (_n: string, cmd: string, p: { path: string }) => (dispatched.push({ cmd, ...p }), LS[p.path] ?? { node: null, entries: [], truncated: false }),
    ...(over.mint === false ? {} : { mintDownloadTicket: (c: DownloadClaims) => (minted.push(c), { ticket: 'tkt/1', expiresAt: 0 }) }),
    downloadStatus: () => ({ orgId: 'org1', userId: 'u1', state: 'streaming', bytes: 10, error: null, updatedAt: 1 }),
  };
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'bkp-target', 't1', { name: 'disk', kind: 'NODE', bucket: '/srv/backups', resticPasswordRef: encryptSecret('pw'), enabled: true });
  const db = {
    snapshot: { findFirst: async () => (over.snapshot === undefined ? SAVED : over.snapshot) },
    auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => (audit.push(data), data) },
  };
  return { db, hub, activeOrgId: 'org1', user: { id: over.user ?? 'u1' } } as never;
}

beforeEach(() => {
  audit = [];
  minted = [];
  dispatched = [];
});

describe('browseSnapshot', () => {
  it('lists one folder on the server that holds a node-path save, paths volume-relative', async () => {
    const v = await browseSnapshot(ctx(), { snapshotId: 'snap1', path: '/' });
    expect(v.path).toBe('');
    expect(v.entries.map((e) => [e.path, e.type, e.sizeBytes])).toEqual([['img', 'dir', null], ['a.txt', 'file', '6']]);
    expect(v.maxBytes).toBe(String(2 * 1024 ** 3));
    expect(dispatched[0]).toMatchObject({ cmd: 'backup.ls', path: '/data', snapshotId: 'abc123', repo: { kind: 'node', repo: '/srv/backups', password: 'pw' } });
  });

  it('refuses .. before anything runs', async () => {
    await expect(browseSnapshot(ctx(), { snapshotId: 'snap1', path: '../etc' })).rejects.toThrow('stay inside this save');
    expect(dispatched).toEqual([]);
  });

  it('refuses an unfinished save and an agent that never advertised the capability', async () => {
    await expect(browseSnapshot(ctx({ snapshot: { ...SAVED, status: 'FAILED' } }), { snapshotId: 'snap1', path: '' })).rejects.toThrow('didn’t finish');
    await expect(browseSnapshot(ctx({ caps: [] }), { snapshotId: 'snap1', path: '' })).rejects.toThrow('too old');
    await expect(browseSnapshot(ctx({ snapshot: null }), { snapshotId: 'nope', path: '' })).rejects.toThrow('not found');
  });
});

describe('mintSnapshotDownload', () => {
  it('a file: mints a ticket that wraps it as data/<path>, and audits the path', async () => {
    const t = await mintSnapshotDownload(ctx(), { snapshotId: 'snap1', path: 'a.txt' });
    expect(t).toMatchObject({ kind: 'file', sizeBytes: '6', fileName: 'shop_uploads-a.txt-20261027-0300.tar.gz', url: '/api/backups/download?ticket=tkt%2F1' });
    expect(minted[0]).toMatchObject({
      orgId: 'org1', userId: 'u1', nodeId: 'n1', maxBytes: 2 * 1024 ** 3,
      start: { snapshotId: 'abc123', path: '/data/a.txt', kind: 'file' },
      entry: { name: 'data/a.txt', size: 6, mtimeMs: Date.parse('2026-10-26T10:00:00Z') },
    });
    expect(audit).toEqual([expect.objectContaining({ action: 'backup.download', metadata: expect.objectContaining({ path: 'a.txt', kind: 'file', volume: 'shop_uploads' }) })]);
  });

  it('a folder: size unknown up front, no tar entry (restic makes the tar)', async () => {
    const t = await mintSnapshotDownload(ctx(), { snapshotId: 'snap1', path: '' });
    expect(t).toMatchObject({ kind: 'dir', sizeBytes: null });
    expect(minted[0]!.entry).toBeUndefined();
    expect(audit[0]!.metadata).toMatchObject({ path: '/' });
  });

  it('refuses past the cap with the size, the limit and where it is set', async () => {
    await expect(mintSnapshotDownload(ctx(), { snapshotId: 'snap1', path: 'huge.bin' })).rejects.toThrow(/3 GB, and downloads stop at 2 GB \(SWARMY_BACKUP_DOWNLOAD_MAX_BYTES/);
    expect(minted).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('refuses a missing path, a link, and a hub with no download route', async () => {
    await expect(mintSnapshotDownload(ctx(), { snapshotId: 'snap1', path: 'nope' })).rejects.toThrow('nothing at “nope”');
    await expect(mintSnapshotDownload(ctx(), { snapshotId: 'snap1', path: 'link' })).rejects.toThrow('is a link');
    await expect(mintSnapshotDownload(ctx({ mint: false }), { snapshotId: 'snap1', path: 'a.txt' })).rejects.toThrow('no download route');
  });
});

describe('snapshotDownloadStatus', () => {
  it('shows a download only to the person who started it', () => {
    expect(snapshotDownloadStatus(ctx(), 'd1')).toEqual({ state: 'streaming', bytes: 10, error: null, updatedAt: 1 });
    expect(snapshotDownloadStatus(ctx({ user: 'someone-else' }), 'd1')).toBeNull();
  });
});
