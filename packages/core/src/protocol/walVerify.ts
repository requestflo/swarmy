/**
 * `dbWalVerify`: is a wal-g PITR cluster's WAL archive continuous? Read-only.
 *
 * One wal-g sidecar, set up like the window check (`dbPitrWindow`: same
 * image, S3 credentials as container env only, same networks), runs
 * `wal-g wal-verify integrity timeline --json`, then lists the archived WAL
 * (`wal-g st ls wal_005/`) for upload times and the base backups. wal-verify
 * asks the live primary for its current WAL segment, so the payload carries
 * the connection: the password becomes the sidecar's 0600 PGPASSFILE, never
 * env, argv or a log line (the physical backup's contract).
 *
 * Gated by the `dbWalVerify` agent capability (`capabilities.ts`): an older
 * agent would drop the frame, so the controller only sends it to an agent
 * that advertised it.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { ResticRepo } from './backup';
import { DbConnection } from './dbBackup';
import { PitrBaseBackup } from './pitrWindow';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const DbWalVerifyPayload = z.object({
  ...cmd,
  engine: z.literal('wal-g'),
  /** The destination the cluster's base backups and WAL go to. */
  repo: ResticRepo,
  /** The live primary: wal-verify reads the current WAL segment from it. */
  conn: DbConnection,
  /** The cluster net (to reach the primary). */
  network: z.string().optional(),
  /** The storage overlay, so an in-cluster destination (`swarmy-garage`) resolves. */
  resticNetwork: z.string().optional(),
  /** wal-g image override; defaults to `DEFAULT_WALG_IMAGE`. */
  engineImage: z.string().optional(),
});
export type DbWalVerifyPayload = z.infer<typeof DbWalVerifyPayload>;

export const DbWalVerifyMsg = z.object({
  type: z.literal('dbWalVerify'),
  payload: DbWalVerifyPayload,
});
export type DbWalVerifyMsg = z.infer<typeof DbWalVerifyMsg>;

/** wal-verify's check status (`OK` / `WARNING` / `FAILURE`), lower-cased. */
export const WalCheckStatus = z.enum(['ok', 'warning', 'failure']);
export type WalCheckStatus = z.infer<typeof WalCheckStatus>;

/**
 * A run of WAL segments in one state: `found` in the archive, `delayed`
 * (Postgres has not archived them yet), `uploading` (on their way), or
 * `lost` (missing for good: a restore cannot replay through them).
 */
export const WalRangeStatus = z.enum(['found', 'delayed', 'uploading', 'lost']);
export type WalRangeStatus = z.infer<typeof WalRangeStatus>;

export const WalRange = z.object({
  timeline: z.number().int().nonnegative(),
  startSegment: z.string(),
  endSegment: z.string(),
  segments: z.number().int().nonnegative(),
  status: WalRangeStatus,
  /**
   * ISO-8601 UTC, from the archive's upload times. A found range spans its
   * first to its last segment; a missing one spans the found segments on
   * either side of it. Absent when the listing had no time for that end.
   */
  from: z.string().optional(),
  to: z.string().optional(),
});
export type WalRange = z.infer<typeof WalRange>;

export const DbWalVerifyResult = z.object({
  /** Integrity: `failure` means at least one `lost` range. */
  integrity: WalCheckStatus,
  /** Oldest first, as wal-verify lists them (from the oldest base backup's start). */
  ranges: z.array(WalRange).default([]),
  /** The current timeline against the highest one in the archive (split-brain guard). */
  timeline: z.object({ status: WalCheckStatus, current: z.number().int(), highestInStorage: z.number().int() }).optional(),
  /** Base backups with a finish time, oldest first. */
  backups: z.array(PitrBaseBackup).default([]),
  /** When the agent read the repo (its clock, ISO-8601 UTC). */
  checkedAt: z.string(),
});
export type DbWalVerifyResult = z.infer<typeof DbWalVerifyResult>;
