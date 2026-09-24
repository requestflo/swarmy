import { z } from 'zod';
import {
  ResilienceBackupVerifyInput,
  ResilienceDrillHistoryInput,
  ResilienceRestoreDrillInput,
} from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  listDrillHistory,
  overview,
  runBackupVerify,
  runRestoreDrill,
} from '../services/resilience.service';

/**
 * Resilience (slice F2) — "what isn't protected yet" over live signals, and the
 * safe drills (restore / backup-verify). Drills are
 * admin-only, confirmed in the UI, and every outcome is an audit row.
 */
export const resilienceRouter = router({
  /** Unprotected items + drill cards + drill targets (poll for live data).
   *  Optional `stack` scopes service signals, backup recency and drills. */
  overview: orgProcedure
    .input(z.object({ stack: z.string().min(1).optional() }).optional())
    .query(({ ctx, input }) => overview(ctx, input)),

  /** Recent drill outcomes, newest first (read back from the audit log). */
  drillHistory: orgProcedure
    .input(ResilienceDrillHistoryInput.extend({ stack: z.string().min(1).optional() }))
    .query(({ ctx, input }) => listDrillHistory(ctx, input.limit, input.stack)),

  /** Clone the latest DB backup into a throwaway cluster, verify, destroy. */
  runRestoreDrill: adminProcedure
    .input(ResilienceRestoreDrillInput)
    .mutation(({ ctx, input }) => runRestoreDrill(ctx, input)),

  /** `restic check` against a backup destination via a one-shot container. */
  runBackupVerify: adminProcedure
    .input(ResilienceBackupVerifyInput)
    .mutation(({ ctx, input }) => runBackupVerify(ctx, input)),
});
