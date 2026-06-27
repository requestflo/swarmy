import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  addRepo,
  getGcPolicy,
  getRegistryConfig,
  listBuilds,
  listRepos,
  removeRepo,
  setGcPolicy,
  setRegistryEnabled,
  triggerBuild,
} from '../services/cicd.service';

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
});
