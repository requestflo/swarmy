import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import {
  getConfig,
  listRemoteSnapshots,
  listSnapshots,
  runControllerBackup,
  setConfig,
  setRestorePassphrase,
} from '../services/controllerBackup.service';
import {
  migratePlan,
  provisionManagedPostgres,
} from '../services/controllerDb.service';
import { generateRestorePassphrase } from '@swarmy/core/crypto';

/**
 * Controller-state backup/restore + data-store upgrade — PLATFORM level. Scoped
 * to `adminProcedure` (org admin/owner): this is the closest guard the current
 * auth model exposes. In a multi-tenant deployment, gate this further to a true
 * super-admin (see INTEGRATION note). The config and snapshots are singular /
 * org-independent — they span the whole controller.
 */
const retention = z.object({
  keepDaily: z.number().int().nonnegative(),
  keepWeekly: z.number().int().nonnegative(),
  keepMonthly: z.number().int().nonnegative(),
});

export const controllerBackupRouter = router({
  getConfig: adminProcedure.query(({ ctx }) => getConfig(ctx.db)),

  setConfig: adminProcedure
    .input(
      z.object({
        targetId: z.string().nullable().optional(),
        schedule: z.string().optional(),
        enabled: z.boolean().optional(),
        retention: retention.optional(),
      }),
    )
    .mutation(({ ctx, input }) => setConfig(ctx, input)),

  /** Generate a fresh, card-friendly restore passphrase (shown once, not stored). */
  generatePassphrase: adminProcedure.mutation(() => ({
    passphrase: generateRestorePassphrase(),
  })),

  /** Capture the user-held restore passphrase. Returns a fingerprint only. */
  setPassphrase: adminProcedure
    .input(z.object({ passphrase: z.string().min(8) }))
    .mutation(({ ctx, input }) => setRestorePassphrase(ctx, input.passphrase)),

  runNow: adminProcedure.mutation(({ ctx }) => runControllerBackup(ctx)),

  listSnapshots: adminProcedure.query(({ ctx }) => listSnapshots(ctx.db)),

  /** Live restic catalog for the configured target (restore picker). */
  listRemoteSnapshots: adminProcedure.query(({ ctx }) => listRemoteSnapshots(ctx.db)),

  // ── data-store upgrade (managed Postgres) ──
  provisionManagedPostgres: adminProcedure.mutation(async ({ ctx }) => {
    const result = await provisionManagedPostgres(ctx);
    return {
      serviceName: result.serviceName,
      databaseUrl: result.databaseUrl,
      image: result.image,
      steps: migratePlan(result),
    };
  }),
});
