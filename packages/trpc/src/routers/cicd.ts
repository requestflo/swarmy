import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
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
  subscribeBuildLog,
  triggerBuild,
} from '../services/cicd.service';
import { runImageGcForOrg } from '../services/image-gc.service';

const CONTROLLER_PUBLIC_URL =
  process.env.CONTROLLER_PUBLIC_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3001';

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
  removeRepo: adminProcedure
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
  webhookInfo: adminProcedure
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

  // ── GC policy ──
  getGcPolicy: orgProcedure.query(({ ctx }) => getGcPolicy(ctx)),
  setGcPolicy: adminProcedure
    .input(
      z.object({
        mode: z.enum(['on-healthcheck', 'age-days']),
        keepProd: z.boolean(),
        days: z.number().int().positive().nullable(),
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
});
