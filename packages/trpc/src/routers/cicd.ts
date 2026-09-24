import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  addRepo,
  getBuildLogPage,
  getGcPolicy,
  getRegistryConfig,
  getWebhookInfo,
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

const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3021';

const providerEnum = z.enum(['github', 'gitlab']);

export const cicdRouter = router({
  // ── Repos ──
  listRepos: orgProcedure.query(({ ctx }) => listRepos(ctx)),
  addRepo: adminProcedure
    .input(
      z.object({
        provider: providerEnum,
        url: z.string().min(1),
        branch: z.string().optional(),
        token: z.string().optional(),
        autodeploy: z.boolean().optional(),
        serviceId: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => addRepo(ctx, input)),
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

  // Webhook URL + secret to paste into the provider (GitHub/GitLab).
  webhookInfo: abacProcedure('secrets.read')
    .input(z.object({ repoId: z.string() }))
    .query(({ ctx, input }) => getWebhookInfo(ctx, input.repoId, CONTROLLER_PUBLIC_URL)),

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
