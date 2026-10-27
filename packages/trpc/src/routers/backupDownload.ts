import { z } from 'zod';
import { orgProcedure } from '../trpc';
import { abacProcedure } from '../abac';
import { resolveSnapshotStack } from '../abac-snapshot';
import { browseSnapshot, mintSnapshotDownload, snapshotDownloadStatus } from '../services/backupDownload.service';

/**
 * Look inside a volume save and download one file or folder (board 16),
 * spread into `backups`. What a save holds is as sensitive as the live data
 * (keys, dumps, uploads), so listing and downloading both take `data.restore`
 * on the save's app — owner/admin-only by the seeded defaults, every decision
 * audited — rather than the member-permitted `data.read` (database rows).
 */
const target = z.object({ snapshotId: z.string().min(1), path: z.string().max(4096).default('') });

export const backupDownloadProcedures = {
  /** One folder of a save (`restic ls` on a server that can read it). */
  browseSnapshot: abacProcedure('data.restore', resolveSnapshotStack)
    .input(target)
    .query(({ ctx, input }) => browseSnapshot(ctx, input)),

  /** A single-use, 30-second link to `/api/backups/download` for one file or folder; audited with the path. */
  downloadTicket: abacProcedure('data.restore', resolveSnapshotStack)
    .input(target)
    .mutation(({ ctx, input }) => mintSnapshotDownload(ctx, input)),

  /** How the download you started is going: bytes sent, done, or why it stopped. */
  downloadStatus: orgProcedure
    .input(z.object({ downloadId: z.string().uuid() }))
    .query(({ ctx, input }) => snapshotDownloadStatus(ctx, input.downloadId)),
};
