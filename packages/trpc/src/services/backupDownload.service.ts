/**
 * Look inside a volume backup and download one file or folder (board 16).
 *
 * `browseSnapshot` lists one folder (`restic ls` on a server that can read the
 * save). `mintSnapshotDownload` checks the path, refuses a file past the cap,
 * mints a single-use 30 s ticket and audits `backup.download` with the path;
 * the browser then fetches `/api/backups/download?ticket=…`, which streams
 * `restic dump` from the agent as a .tar.gz (apps/api/src/downloads). Both
 * sit behind `data.restore` (routers/backupDownload.ts).
 */
import {
  DOWNLOAD_MAX_ENV,
  downloadFileName,
  parseDownloadMaxBytes,
  tooLargeWords,
} from '@swarmy/core';
import { AGENT_CAPABILITY } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import type { DownloadClaims, DownloadStatusView } from '../hub/types';
import { writeAudit } from './audit.service';
import { entryView, lsSnapshot, openSnapshotRead, type SnapshotEntryView } from './backupDownload.read';

/** Children one browse returns (the agent stops restic past it). */
export const BROWSE_LIMIT = 500;

export interface SnapshotBrowseView {
  /** Volume-relative path that was listed (`` = the top). */
  path: string;
  node: SnapshotEntryView | null;
  entries: SnapshotEntryView[];
  truncated: boolean;
  /** The download cap in bytes, so the picker can say it up front. */
  maxBytes: string;
}

export interface DownloadTicketView {
  downloadId: string;
  /** Same-origin, single-use, valid for 30 s. */
  url: string;
  fileName: string;
  kind: 'file' | 'dir';
  /** Known for a file; a folder's size shows as it downloads. */
  sizeBytes: string | null;
  maxBytes: string;
  expiresAt: string;
}

export function downloadMaxBytes(): number {
  return parseDownloadMaxBytes(process.env[DOWNLOAD_MAX_ENV]);
}

export async function browseSnapshot(
  ctx: OrgContext,
  input: { snapshotId: string; path: string },
): Promise<SnapshotBrowseView> {
  const r = await openSnapshotRead(ctx, input, AGENT_CAPABILITY.snapshotLs);
  const ls = await lsSnapshot(ctx, r, BROWSE_LIMIT);
  return {
    path: r.rel,
    node: ls.node ? entryView(ls.node) : null,
    entries: ls.entries.map(entryView),
    truncated: ls.truncated,
    maxBytes: String(downloadMaxBytes()),
  };
}

/**
 * The dump runs the same restic read sidecar as `backup.ls`, so its image
 * arrives the same way: digest-pinned and, on a cluster with a trusted mirror
 * and an agent that takes it, the mirrored copy with its fallback and login.
 * The start isn't a dispatch, so it asks the decorator itself; only the
 * image fields are taken from it.
 */
export async function readImageFor(ctx: OrgContext, nodeId: string, start: DownloadClaims['start']): Promise<DownloadClaims['start']> {
  const out = (await ctx.hub.decorateDispatch?.(ctx.activeOrgId, 'backup.ls', start, nodeId)) as Partial<DownloadClaims['start']> | undefined;
  if (!out) return start;
  const { image, fallbackImage, registryAuth } = out;
  return { ...start, ...(image ? { image } : {}), ...(fallbackImage ? { fallbackImage } : {}), ...(registryAuth ? { registryAuth } : {}) };
}

export async function mintSnapshotDownload(
  ctx: OrgContext,
  input: { snapshotId: string; path: string },
): Promise<DownloadTicketView> {
  const r = await openSnapshotRead(ctx, input, AGENT_CAPABILITY.snapshotDump);
  const { node } = await lsSnapshot(ctx, r, 1);
  const where = r.rel ? `“${r.rel}”` : 'the top of the volume';
  if (!node) throw commandRejected(`This save has nothing at ${where}.`);
  if (node.type !== 'file' && node.type !== 'dir') throw commandRejected(`${where} is a link, not a file or folder.`);
  const maxBytes = downloadMaxBytes();
  if (node.type === 'file' && (node.size ?? 0) > maxBytes) throw commandRejected(tooLargeWords(maxBytes, node.size));
  if (!ctx.hub.mintDownloadTicket) throw commandRejected('This controller has no download route, so it can’t serve downloads.');

  const downloadId = crypto.randomUUID();
  const fileName = downloadFileName({ volume: r.snapshot.volume, rel: r.rel, savedAt: r.snapshot.startedAt });
  const claims: DownloadClaims = {
    downloadId,
    orgId: ctx.activeOrgId,
    userId: ctx.user.id,
    nodeId: r.nodeId,
    start: await readImageFor(ctx, r.nodeId, { repo: r.repo, snapshotId: r.snapshot.resticId, path: r.abs, kind: node.type, network: r.network }),
    fileName,
    maxBytes,
    // A file comes out of restic as its bare bytes: the controller wraps it in
    // a tar entry named the way a folder's entries are (`data/<path>`).
    ...(node.type === 'file'
      ? { entry: { name: r.abs.slice(1), size: node.size ?? 0, mtimeMs: Date.parse(node.mtime ?? '') || r.snapshot.startedAt.getTime() } }
      : {}),
    audit: { snapshotId: r.snapshot.id, volume: r.snapshot.volume, path: r.rel || '/' },
  };
  const { ticket, expiresAt } = ctx.hub.mintDownloadTicket(claims);
  const sizeBytes = node.type === 'file' && node.size != null ? String(node.size) : null;
  await writeAudit(ctx, {
    action: 'backup.download',
    targetType: 'snapshot',
    targetId: r.snapshot.id,
    metadata: { volume: r.snapshot.volume, path: r.rel || '/', kind: node.type, sizeBytes, nodeId: r.nodeId, downloadId },
  });
  return {
    downloadId,
    url: `/api/backups/download?ticket=${encodeURIComponent(ticket)}`,
    fileName,
    kind: node.type,
    sizeBytes,
    maxBytes: String(maxBytes),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** The progress of a download this person started in this org; null otherwise. */
export function snapshotDownloadStatus(ctx: OrgContext, downloadId: string): DownloadStatusView | null {
  const s = ctx.hub.downloadStatus?.(downloadId);
  if (!s || s.orgId !== ctx.activeOrgId || s.userId !== ctx.user.id) return null;
  return { state: s.state, bytes: s.bytes, error: s.error, updatedAt: s.updatedAt };
}
