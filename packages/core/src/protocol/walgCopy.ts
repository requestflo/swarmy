/**
 * `dbWalgCopy`: copy a wal-g PITR cluster's base backup, and the WAL archived
 * since it, from its main destination to a second one ("also copy to").
 *
 * wal-g writes WAL to one storage (its failover storages are a fallback, not
 * a second copy), so a second destination is made with `wal-g copy --from
 * <cfg> --to <cfg> --backup-name <base>` after each scheduled base backup.
 * Each side's S3 credentials ride as container env only; the sidecar writes
 * the two wal-g config files to its own /dev/shm (memory), never to node disk
 * or argv. It then reads the copy's own window back (`backup-list` + WAL
 * listing in the second destination), which is the lag figure: a restore from
 * the copy reaches as far as the copy run did.
 *
 * Touches no volume and no server. Gated by the `dbWalgCopy` agent
 * capability: an older agent would drop the frame.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { ResticRepo } from './backup';
import { DbPitrWindowResult } from './pitrWindow';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const DbWalgCopyPayload = z.object({
  ...cmd,
  engine: z.literal('wal-g'),
  /** The main destination (the cluster's WALG_S3_PREFIX). */
  from: ResticRepo,
  /** The second destination. */
  to: ResticRepo,
  /** The base backup to copy with the WAL since it (`base_…`), or `LATEST`. */
  backupName: z.string().min(1),
  /** The storage overlay, when either destination is in-cluster (`swarmy-garage`). */
  resticNetwork: z.string().optional(),
  /** wal-g image override; defaults to `DEFAULT_WALG_IMAGE`. */
  engineImage: z.string().optional(),
});
export type DbWalgCopyPayload = z.infer<typeof DbWalgCopyPayload>;

export const DbWalgCopyMsg = z.object({
  type: z.literal('dbWalgCopy'),
  payload: DbWalgCopyPayload,
});
export type DbWalgCopyMsg = z.infer<typeof DbWalgCopyMsg>;

/** The base backup copied, and the second destination's own window read right after. */
export const DbWalgCopyResult = DbPitrWindowResult.extend({
  backupName: z.string(),
});
export type DbWalgCopyResult = z.infer<typeof DbWalgCopyResult>;
