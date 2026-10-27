import { checkSnapshotPath, relSnapshotPath } from '@swarmy/core';
import type { AgentCapability, ResticRepo, SnapshotLsResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { badRequest, commandRejected, mapDispatchError, notFound } from '../errors';
import { loadTarget, resticNetworkFor, toResticRepo } from './backups.service';
import { pickReadNode } from './backupDownload.node';

/**
 * The shared first step of browse + download: the save (org-scoped, saved,
 * with a restic id), its destination (credentials decrypted in memory only),
 * a server able to read it, and one `restic ls` of the path.
 */

export interface SnapshotRead {
  snapshot: { id: string; volume: string; resticId: string; startedAt: Date };
  repo: ResticRepo;
  network: string | undefined;
  nodeId: string;
  rel: string;
  abs: string;
}

export async function openSnapshotRead(
  ctx: OrgContext,
  input: { snapshotId: string; path: string },
  cap: AgentCapability,
): Promise<SnapshotRead> {
  const path = checkSnapshotPath(input.path);
  if (!path.ok) throw badRequest(path.reason);
  const snap = await ctx.db.snapshot.findFirst({ where: { id: input.snapshotId, orgId: ctx.activeOrgId } });
  if (!snap) throw notFound('snapshot', input.snapshotId);
  if (snap.status !== 'SUCCEEDED' || !snap.resticId) throw commandRejected('This save didn’t finish, so there is nothing to look inside.');
  const target = await loadTarget(ctx, snap.targetId);
  const repo = toResticRepo(target);
  const pick = pickReadNode({
    repoKind: repo.kind,
    hostNodeId: snap.hostNodeId,
    managerIds: ctx.hub.managerNodes(ctx.activeOrgId),
    isOnline: (n) => ctx.hub.isOnline(n),
    capabilities: (n) => ctx.hub.agentBuildFor?.(n)?.capabilities,
    cap,
  });
  if ('refuse' in pick) throw commandRejected(pick.refuse);
  return {
    snapshot: { id: snap.id, volume: snap.volume, resticId: snap.resticId, startedAt: snap.startedAt },
    repo,
    network: resticNetworkFor(target.endpoint),
    nodeId: pick.nodeId,
    rel: path.rel,
    abs: path.abs,
  };
}

/** `restic ls` of the read's path on its server. */
export async function lsSnapshot(ctx: OrgContext, r: SnapshotRead, limit: number): Promise<SnapshotLsResult> {
  try {
    return await ctx.hub.dispatch<SnapshotLsResult>(r.nodeId, 'backup.ls', {
      repo: r.repo,
      snapshotId: r.snapshot.resticId,
      path: r.abs,
      limit,
      network: r.network,
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export interface SnapshotEntryView {
  /** Volume-relative path (`config/app.yml`). */
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  /** Bytes as a string (BigInt-safe on the wire), files only. */
  sizeBytes: string | null;
  mtime: string | null;
}

export function entryView(e: SnapshotLsResult['entries'][number]): SnapshotEntryView {
  return {
    path: relSnapshotPath(e.path),
    name: e.name,
    type: e.type,
    sizeBytes: e.size != null ? String(e.size) : null,
    mtime: e.mtime ?? null,
  };
}
