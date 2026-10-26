/**
 * git-apps (Phase 3): the GitOps loop's surface — the apps a swarmy.yaml
 * describes, their plans per environment, confirming held (destructive)
 * steps, the per-app require-approval toggle, and "deploy the branch head
 * now". Confirming is authorized per step inside the service by what the step
 * destroys (`data.destroy` / `service.remove` / `stack.deploy` via
 * evaluateAccess), and audited.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure, resolveStackByName, type ResolveResource } from '../abac';
import {
  createAppPreview,
  teardownAppPreview,
  confirmAppActions,
  checkDriftNow,
  getPlan,
  listApps,
  promoteEnvironment,
  purgeAppData,
  replan,
  retryPlan,
  setEnforceDrift,
  setRequireApproval,
} from '../services/apps.service';
import { readAppConfigFile } from '../services/apps/config-file';
import { appEnvironmentProcedures } from './apps-environments';
import { appPreviewProcedures } from './apps-previews';
import { convertToConfig } from '../services/apps/convert';

const id = z.string().min(1).max(100);

/**
 * The live preview stack a `{ repoId, prNumber }` names (org-scoped plan row
 * → the stack's live labels), so a policy on that stack applies to its
 * teardown. Malformed input resolves to the org; an unknown preview is
 * NOT_FOUND, never "authorize as the org".
 */
const resolvePreviewStack: ResolveResource = async (ctx, input) => {
  const i = (input ?? {}) as { repoId?: unknown; prNumber?: unknown };
  if (typeof i.repoId !== 'string' || typeof i.prNumber !== 'number') return null;
  const row = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, repoId: i.repoId, environment: 'preview', prNumber: i.prNumber },
    orderBy: { updatedAt: 'desc' },
    select: { stack: true },
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'that preview is gone' });
  return resolveStackByName(ctx, { stack: row.stack });
};

export const appsRouter = router({
  ...appEnvironmentProcedures,
  ...appPreviewProcedures,
  list: orgProcedure.query(({ ctx }) => listApps(ctx)),
  /**
   * The swarmy.yaml text an app stack runs from (its last planned commit), for
   * the Source tab's editor. Read-only; cached per commit. Null = not a git app.
   */
  configFile: orgProcedure
    .input(z.object({ stack: z.string().min(1).max(100) }))
    .query(({ ctx, input }) => readAppConfigFile(ctx, input)),
  /**
   * "Convert to swarmy.yaml" for an app deployed from compose: the compose it
   * was deployed from as a swarmy.yaml (checked by the controller's parser)
   * and what didn't translate, with why. Read-only; nothing is written to git.
   */
  convertToConfig: orgProcedure
    .input(z.object({ stack: z.string().min(1).max(100) }))
    .query(({ ctx, input }) => convertToConfig(ctx, input)),
  plan: orgProcedure
    .input(z.object({ planId: id }))
    .query(({ ctx, input }) => getPlan(ctx, input.planId)),

  /** Confirm held steps (each is ABAC-checked by what it destroys). */
  confirm: orgProcedure
    .input(z.object({ planId: id, actionIds: z.array(z.string().min(1).max(300)).min(1).max(50) }))
    .mutation(({ ctx, input }) => confirmAppActions(ctx, input)),

  setRequireApproval: adminProcedure
    .input(z.object({ repoId: id, requireApproval: z.boolean() }))
    .mutation(({ ctx, input }) => setRequireApproval(ctx, input)),

  /** Re-run a FAILED plan: re-plans the same commit and applies it (audited `app.plan.retry`). */
  retryPlan: adminProcedure
    .input(z.object({ planId: id }))
    .mutation(({ ctx, input }) => retryPlan(ctx, input)),

  /** Plan + apply the head of a branch now (production branch by default). */
  deploy: adminProcedure
    .input(z.object({ repoId: id, branch: z.string().min(1).max(200).optional() }))
    .mutation(({ ctx, input }) => replan(ctx, input)),

  /** "Check now": compare the last applied commit with live state (no changes made); refreshes AppView.drift. */
  drift: orgProcedure
    .input(z.object({ repoId: id }))
    .query(({ ctx, input }) => checkDriftNow(ctx, input.repoId)),

  /** Opt in to re-applying drift on git-owned fields (default: report only). */
  setEnforceDrift: adminProcedure
    .input(z.object({ repoId: id, enforceDrift: z.boolean() }))
    .mutation(({ ctx, input }) => setEnforceDrift(ctx, input)),

  /**
   * Delete a REMOVED Postgres's data permanently (its volumes on every node).
   * `data.destroy` is checked in the service; `confirm` must be `<stack>/<resource>`.
   */
  purgeData: orgProcedure
    .input(
      z.object({
        repoId: id,
        environment: z.string().min(1).max(40),
        resource: z.string().min(1).max(40),
        confirm: z.string().min(1).max(200),
      }),
    )
    .mutation(({ ctx, input }) => purgeAppData(ctx, input)),

  /**
   * Preview a branch (no pull request needed) — the same engine as a PR or
   * branch preview, and the same guard as REST `POST /apps/{repoId}/previews`
   * (any member; the plan's own gates still apply).
   */
  createPreview: orgProcedure
    .input(z.object({ repoId: id, branch: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => createAppPreview(ctx, input)),

  /** Tear a preview down now (its services and throwaway resources) — `stack.remove` on the preview stack. */
  teardownPreview: abacProcedure('stack.remove', resolvePreviewStack)
    .input(z.object({ repoId: id, prNumber: z.number().int().min(1) }))
    .mutation(({ ctx, input }) => teardownAppPreview(ctx, input, { byUser: true })),

  /** Promote an environment's running digests (staging) to production — no rebuild, same gates. */
  promote: adminProcedure
    .input(z.object({ repoId: id, from: z.string().min(1).max(40), dryRun: z.boolean().optional() }))
    .mutation(({ ctx, input }) => promoteEnvironment(ctx, input)),
});
