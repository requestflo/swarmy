/**
 * Git provider connections (git-apps Phase 2): register the controller's
 * GitHub App, bind installations, connect GitLab/Gitea/generic git, pick a
 * repo + branch, link it as an app binding, and read a commit (git.inspect).
 * Secrets never leave the service layer; mutations are admin-only and
 * audited, removal is ABAC-gated (`cicd.remove`).
 */
import { z } from 'zod';
import { abacProcedure } from '../abac';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  createConnection,
  getGithubApp,
  githubInstallLink,
  inspectCommit,
  inspectSource,
  linkRepo,
  listConnections,
  listProviderBranches,
  listProviderRepos,
  removeConnection,
  startGithubManifest,
  updateRepo,
} from '../services/git-connections.service';

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid branch name');
const configPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(\.\/)?[A-Za-z0-9._/@+-]*swarmy\.ya?ml$/, 'must point at a swarmy.yaml')
  .refine((p) => !p.split('/').includes('..'), 'no .. segments');

export const gitConnectionsRouter = router({
  list: orgProcedure.query(({ ctx }) => listConnections(ctx)),

  githubApp: orgProcedure
    .input(z.object({ webBase: httpUrl.optional() }).optional())
    .query(({ ctx, input }) => getGithubApp(ctx, input?.webBase)),

  /** Returns `{ postUrl, manifest }` — the dashboard auto-submits a form with field `manifest`. */
  startGithubManifest: adminProcedure
    .input(
      z
        .object({
          githubOrg: z.string().min(1).max(100).optional(),
          name: z.string().min(1).max(34).optional(),
          webBase: httpUrl.optional(),
        })
        .optional(),
    )
    .mutation(({ ctx, input }) => startGithubManifest(ctx, input ?? {})),

  githubInstallLink: adminProcedure
    .input(z.object({ webBase: httpUrl.optional() }).optional())
    .mutation(({ ctx, input }) => githubInstallLink(ctx, input?.webBase)),

  create: adminProcedure
    .input(
      z.discriminatedUnion('mode', [
        z.object({
          kind: z.literal('gitlab'),
          mode: z.literal('oauth'),
          baseUrl: httpUrl.optional(),
          clientId: z.string().min(1).max(200),
          clientSecret: z.string().min(1).max(500),
        }),
        z.object({
          kind: z.literal('gitlab'),
          mode: z.literal('token'),
          baseUrl: httpUrl.optional(),
          token: z.string().min(8).max(500),
        }),
        z.object({
          kind: z.enum(['gitea', 'generic']),
          mode: z.literal('basic'),
          baseUrl: httpUrl,
          displayName: z.string().min(1).max(80).optional(),
          token: z.string().min(1).max(500).optional(),
          tokenUser: z.string().min(1).max(100).optional(),
        }),
      ]),
    )
    .mutation(({ ctx, input }) => {
      if (input.kind === 'gitlab') return createConnection(ctx, input);
      const { mode: _mode, ...rest } = input;
      return createConnection(ctx, rest);
    }),

  remove: abacProcedure('cicd.remove')
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => removeConnection(ctx, input.id)),

  repos: orgProcedure
    .input(z.object({ connectionId: z.string().min(1), search: z.string().max(100).optional() }))
    .query(({ ctx, input }) => listProviderRepos(ctx, input)),

  branches: orgProcedure
    .input(z.object({ connectionId: z.string().min(1), repo: z.string().min(1).max(300) }))
    .query(({ ctx, input }) => listProviderBranches(ctx, input)),

  /** Link a repo (+ branch + swarmy.yaml path) as an app binding. */
  linkRepo: adminProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
          repo: z
            .object({
              id: z.string().min(1),
              fullName: z.string().min(1),
              cloneUrl: z.string().min(1),
            })
            .optional(),
          url: z.string().min(1).max(500).optional(),
          branch,
          configPath: configPath.optional(),
          deployKey: z.boolean().optional(),
        })
        .refine((v) => Boolean(v.repo) !== Boolean(v.url), 'give either a picked repo or a URL'),
    )
    .mutation(({ ctx, input }) => linkRepo(ctx, input)),

  /** Read a commit on a Builder: swarmy.yaml + notable files + changed paths. */
  inspect: adminProcedure
    .input(
      z.object({
        repoId: z.string().min(1),
        ref: z.string().min(1).max(200).optional(),
        baseSha: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
        paths: z.array(configPath).max(20).optional(),
      }),
    )
    .mutation(({ ctx, input }) => inspectCommit(ctx, input)),

  /** Read a repo before linking it (wizard: detect swarmy.yaml paths / Dockerfile / compose). */
  inspectSource: adminProcedure
    .input(
      z.object({
        connectionId: z.string().min(1).optional(),
        cloneUrl: z.string().min(1).max(500),
        ref: z.string().min(1).max(200),
        paths: z.array(configPath).max(20).optional(),
      }),
    )
    .mutation(({ ctx, input }) => inspectSource(ctx, input)),

  /** Change a linked repo's branch / swarmy.yaml path without re-linking. */
  updateRepo: adminProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          branch: branch.optional(),
          configPath: configPath.optional(),
        })
        .refine((v) => v.branch || v.configPath, 'nothing to change'),
    )
    .mutation(({ ctx, input }) => updateRepo(ctx, input)),
});
