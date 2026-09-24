import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { getRegistryCache, setRegistryCacheCredentials } from '../services/system-images.service';
import { abacProcedure } from '../abac';
import {
  getBuildLogPage,
  getGcPolicy,
  getRegistryConfig,
  listBuilds,
  listRepos,
  removeRepo,
  setGcPolicy,
  setRegistryEnabled,
  rotateRegistryCredentials,
  subscribeBuildLog,
  triggerBuild,
} from '../services/cicd.service';
import { runCacheGcForOrg, runImageGcForOrg } from '../services/image-gc.service';

export const cicdRouter = router({
  // ── Repos ──
  listRepos: orgProcedure.query(({ ctx }) => listRepos(ctx)),
  removeRepo: abacProcedure('cicd.remove')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeRepo(ctx, input.id)),

  // ── Builds ──
  listBuilds: orgProcedure
    .input(z.object({ repoId: z.string().optional() }).optional())
    .query(({ ctx, input }) => listBuilds(ctx, input?.repoId)),
  triggerBuild: adminProcedure
    .input(z.object({ repoId: z.string(), ref: z.string().optional() }))
    .mutation(({ ctx, input }) => triggerBuild(ctx, input)),
  // ── Build logs (live viewer) ──
  buildLogPage: orgProcedure
    .input(z.object({ buildId: z.string() }))
    .query(({ ctx, input }) => getBuildLogPage(ctx, input.buildId)),
  buildLogs: orgProcedure
    .input(z.object({ buildId: z.string() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const ac = signal ?? new AbortController().signal;
      yield* subscribeBuildLog(ctx, input.buildId, ac);
    }),

  // ── Registry ──
  getRegistryConfig: orgProcedure.query(({ ctx }) => getRegistryConfig(ctx)),
  setRegistryEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean(), username: z.string().optional(), password: z.string().optional() }))
    .mutation(({ ctx, input }) => setRegistryEnabled(ctx, input)),
  /** Mint a new auto-generated login; re-stamps pull creds on registry-backed services. */
  rotateRegistryCredentials: adminProcedure.mutation(({ ctx }) => rotateRegistryCredentials(ctx)),
  /** The Docker Hub pull-through cache's login (username only — never the password). */
  getRegistryCache: orgProcedure.query(({ ctx }) => getRegistryCache(ctx)),
  /** Log the cache in to Docker Hub (lifts the anonymous rate limit); `null` clears it. */
  setRegistryCacheCredentials: adminProcedure
    .input(
      z.object({
        login: z.object({ username: z.string().min(1).max(255), password: z.string().min(1).max(4096) }).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => setRegistryCacheCredentials(ctx, input.login)),

  // ── GC policy ──
  getGcPolicy: orgProcedure.query(({ ctx }) => getGcPolicy(ctx)),
  setGcPolicy: adminProcedure
    .input(
      z.object({
        mode: z.enum(['on-healthcheck', 'age-days']),
        keepProd: z.boolean(),
        days: z.number().int().positive().nullable(),
        cacheMaxAgeDays: z.number().int().min(1).max(365).optional(),
        cacheMaxGb: z.number().int().min(1).max(10_000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setGcPolicy(ctx, input)),
  // Run GC now (or preview). `dryRun` reports the plan without removing anything.
  runGc: adminProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(({ ctx, input }) =>
      runImageGcForOrg(
        { db: ctx.db, hub: ctx.hub, auth: ctx.auth },
        ctx.activeOrgId,
        { dryRun: input?.dryRun },
      ),
    ),
  // Registry build-cache GC now (or preview): stale / over-budget `buildcache-*` tags.
  runCacheGc: adminProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(({ ctx, input }) =>
      runCacheGcForOrg({ db: ctx.db, hub: ctx.hub, auth: ctx.auth }, ctx.activeOrgId, { dryRun: input?.dryRun }),
    ),
});
