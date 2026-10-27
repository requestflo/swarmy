import { z } from 'zod';
import { abacProcedure, resolveStackByName } from '../abac';
import { setDbBackupSecondary } from '../services/dbBackupCopy.service';

/**
 * "Also copy to" on a managed-Postgres backup schedule (board 40), spread
 * into `dbBackups`: each save is copied to a second destination too, and
 * `dbBackups.overview` / `backups.copyLag` say how far that copy trails.
 * Restores pick the copy by passing its `targetId` (`dbBackups.list`,
 * `.restore`, `.restoreAsCopy`), e.g. when the main destination is down.
 * The same right as changing the schedule (`stack.deploy`).
 */
export const dbBackupCopyProcedures = {
  setSecondary: abacProcedure('stack.deploy', resolveStackByName)
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1), secondaryTargetId: z.string().min(1).nullable() }))
    .mutation(({ ctx, input }) => setDbBackupSecondary(ctx, input)),
};
