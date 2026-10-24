/**
 * Platform upgrades router — Settings → Platform (plans/epic-platform-upgrades.md).
 *
 * Reads are org-visible (members see which version they run). Every mutation
 * is gated by `authconfig.write` — the controller-level configuration action,
 * owner/admin-only in the seeded defaults (an org can grant it by policy) —
 * and audited by its service.
 */
import { z } from 'zod';
import { MaintenanceWindow } from '@swarmy/core/platform-manifest';
import { orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { checkFeed, getReleaseView, importRelease, setPolicy } from '../services/platform-release.service';
import {
  cancelPlatformUpgrade,
  getPlatformRun,
  getPlatformStatus,
  retryPlatformUpgrade,
  startPlatformUpgrade,
} from '../services/platform-upgrade.service';
import { abandonPlatformUpgrade, requestPlatformPause, resumePlatformUpgrade } from '../services/platform-upgrade-control.service';
import { writeAudit } from '../services/audit.service';
import { platformBundleRouter } from './platform-bundle';

const PLATFORM_ACTION = 'authconfig.write' as const;

export const platformRouter = router({
  /** Current vs available release, policy, the latest run (live timeline) and run history. */
  status: orgProcedure.query(({ ctx }) => getPlatformStatus(ctx)),

  /** One run's full step timeline + log. */
  run: orgProcedure.input(z.object({ id: z.string().min(1) })).query(({ ctx, input }) => getPlatformRun(ctx, input.id)),

  /** Check the feed now (the worker also checks every 6 h). */
  check: abacProcedure(PLATFORM_ACTION).mutation(async ({ ctx }) => {
    await checkFeed(ctx);
    await writeAudit(ctx, { action: 'platform.release.check', targetType: 'platformConfig', targetId: ctx.activeOrgId });
    return getReleaseView(ctx);
  }),

  /** Channel (Stable / Edge), feed URL override, auto-apply patches + maintenance window. */
  setPolicy: abacProcedure(PLATFORM_ACTION)
    .input(
      z.object({
        channel: z.enum(['stable', 'edge']).optional(),
        feedUrl: z.string().max(500).nullable().optional(),
        autoApplyPatches: z.boolean().optional(),
        window: MaintenanceWindow.optional(),
      }),
    )
    .mutation(({ ctx, input }) => setPolicy(ctx, input)),

  /**
   * Offline bundle / manual import: a `platform.json` + its `.sig` (verified
   * against the swarmy release key before it is stored). Images the bundle
   * pushed into the built-in registry are adopted as trusted mirror copies.
   */
  importRelease: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ manifest: z.string().min(2).max(512_000), signature: z.string().min(1).max(16_000) }))
    .mutation(({ ctx, input }) => importRelease(ctx, input)),

  /** Offline bundle upload: the whole `swarmy-<ver>.tar` — verified, images loaded into the registry, release offered. */
  bundle: platformBundleRouter,

  /** Upgrade to the available, verified release. `version` guards against a stale page. */
  start: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ version: z.string().optional(), skipBackup: z.boolean().optional() }).optional())
    .mutation(({ ctx, input }) => startPlatformUpgrade(ctx, { ...input, trigger: 'manual' })),

  /** Resume a failed run from its failed step. */
  retry: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => retryPlatformUpgrade(ctx, input.id)),

  /** Dismiss a failed run. */
  cancel: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => cancelPlatformUpgrade(ctx, input.id)),

  /** "Pause after this step" on a running run (`pause: false` takes it back). Survives the controller restarting. */
  pause: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ id: z.string().min(1), pause: z.boolean().default(true) }))
    .mutation(({ ctx, input }) => requestPlatformPause(ctx, input)),

  /** Carry a paused run on from the step it stopped before. */
  resume: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => resumePlatformUpgrade(ctx, input.id)),

  /** Give up on a paused run: agents + system services go back (health-checked); the controller and a Garage major stay. */
  abandon: abacProcedure(PLATFORM_ACTION)
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => abandonPlatformUpgrade(ctx, input.id)),
});
