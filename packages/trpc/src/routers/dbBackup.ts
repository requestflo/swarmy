import { z } from 'zod';
import { RunDbBackupInput, SetDbBackupScheduleInput } from '@swarmy/core';
import { DbBackupEngine, DbRestoreMode } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, authorize, resolveStackByName } from '../abac';
import {
  dbBackupOverview,
  getDbBackupSchedule,
  getDbPitrWindow,
  listDbBackups,
  restoreDb,
  runDbBackup,
  setDbBackupSchedule,
} from '../services/dbBackup.service';
import { dbBackupEngineOffers } from '../services/dbBackupEngines';
import { restoreDbAsCopy } from '../services/dbRestoreCopy.service';
import { getDbWalCheck } from '../services/dbWalCheck.service';
import { getDbWrites } from '../services/dbWrites.service';
import { restoreProgress } from '../services/restore-progress';
import { dbBackupCopyProcedures } from './dbBackupCopy';

const copyName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid cluster name');

/**
 * DB-aware backups (slice A1): logical (pg_dump / pg_dumpall /
 * snapshot-from-replica) and physical (wal-g / pgbackrest) backups of a managed
 * Postgres cluster, the recurring schedule (Docker truth — the
 * `swarmy.db.backup.schedule` label on the cluster primary), the org-wide
 * coverage overview, and the richer restore modes (clone / in-place /
 * single-database / pitr). Destinations are the same org-scoped `BackupTarget`s
 * used by volume backups.
 */
export const dbBackupRouter = router({
  /**
   * The engines this controller runs: pgbackrest only with an operator's
   * `SWARMY_PGBACKREST_IMAGE` (swarmy ships no pgBackRest image), else hidden
   * with the reason.
   */
  engines: orgProcedure.query(() => dbBackupEngineOffers()),

  /** "Also copy to": the schedule's second destination (`setSecondary`). */
  ...dbBackupCopyProcedures,

  /** Org-wide coverage: every managed cluster with schedule + last backup + PITR window. */
  overview: orgProcedure.query(({ ctx }) => dbBackupOverview(ctx)),

  /**
   * The real PITR window, read from the cluster's WAL repo by its agent (a
   * read-only `wal-g backup-list`). `source: 'unsupported'` on an agent that
   * predates the check; the overview's estimate stands then.
   */
  pitrWindow: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getDbPitrWindow(ctx, input)),

  /**
   * Is the WAL archive continuous? A read-only `wal-g wal-verify` by the
   * cluster's agent (a read from the last few minutes is reused);
   * `source: 'unsupported'` on an agent that predates it, `none` without
   * wal-g PITR.
   */
  walCheck: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getDbWalCheck(ctx, input)),

  /**
   * Rows written since each save that recorded the primary's write counters
   * (`pg_stat_user_tables`, kept on its `db.backup` audit row), read live
   * through the studio's bounded path (data.read, audited under `writes`).
   * A restart, switch-over or stats reset since says so instead of a count.
   */
  writes: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getDbWrites(ctx, input)),

  /** The cluster's recurring-backup schedule, or null when none is set. */
  getSchedule: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getDbBackupSchedule(ctx, input)),

  /** Enable/replace (or, with enabled:false, clear) the cluster's schedule label. */
  setSchedule: abacProcedure('stack.deploy', resolveStackByName)
    .input(SetDbBackupScheduleInput)
    .mutation(({ ctx, input }) => setDbBackupSchedule(ctx, input)),

  /** "Back up now" — omitted fields default from the cluster's schedule label. */
  run: orgProcedure.input(RunDbBackupInput).mutation(({ ctx, input }) => runDbBackup(ctx, input)),
  /** Catalog of DB backups; destination defaults from the schedule / first target. */
  list: orgProcedure
    .input(
      z.object({
        targetId: z.string().optional(),
        stack: z.string().optional(),
        cluster: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) => listDbBackups(ctx, input)),

  /**
   * Restore. Writing over the source cluster saves its current data first
   * (a `reason:pre-restore` restore point) and is refused if that fails,
   * unless `skipSafetyBackup: true` (audited `db.restore.safety.skip`).
   */
  restore: abacProcedure('data.restore')
    .input(
      z.object({
        stack: z.string().min(1),
        cluster: z.string().min(1),
        engine: DbBackupEngine,
        mode: DbRestoreMode,
        targetId: z.string().optional(),
        snapshotId: z.string().optional(),
        targetTime: z.string().optional(),
        database: z.string().optional(),
        targetStack: z.string().optional(),
        targetCluster: z.string().optional(),
        dataVolume: z.string().optional(),
        skipSafetyBackup: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreDb(ctx, input)),

  /**
   * The restore of this cluster in flight (or finished within the minute):
   * each step, the agent's bytes / WAL segments, and how far a point-in-time
   * replay has got. Process memory; null when there is none.
   */
  restoreProgress: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => restoreProgress.latest(ctx.activeOrgId, `${input.stack}/${input.cluster}`)),

  /**
   * Restore as a copy: create `<cluster>-restore-<mmdd>` beside the source (one
   * copy, same image and placement, wired into no app), wait for it to answer,
   * then restore into it. `data.restore`, plus `stack.deploy` because it
   * provisions a database. Audited `db.restore.copy` (and `db.restore`).
   */
  restoreAsCopy: abacProcedure('data.restore', resolveStackByName)
    .input(
      z.object({
        stack: z.string().min(1),
        cluster: z.string().min(1),
        engine: DbBackupEngine,
        targetId: z.string().optional(),
        snapshotId: z.string().optional(),
        targetTime: z.string().optional(),
        name: copyName.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await authorize(ctx, 'stack.deploy', await resolveStackByName(ctx, input));
      return restoreDbAsCopy(ctx, input);
    }),
});
