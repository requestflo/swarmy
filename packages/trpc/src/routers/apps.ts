/**
 * git-apps (Phase 3): the GitOps loop's surface — the apps a swarmy.yaml
 * describes, their plans per environment, confirming held (destructive)
 * steps, the per-app require-approval toggle, and "deploy the branch head
 * now". Confirming is authorized per step inside the service by what the step
 * destroys (`data.destroy` / `service.remove` / `stack.deploy` via
 * evaluateAccess), and audited.
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  confirmAppActions,
  detectDrift,
  getPlan,
  listApps,
  listPlans,
  purgeAppData,
  replan,
  setEnforceDrift,
  setRequireApproval,
} from '../services/apps.service';

const id = z.string().min(1).max(100);

export const appsRouter = router({
  list: orgProcedure.query(({ ctx }) => listApps(ctx)),

  plans: orgProcedure
    .input(
      z.object({
        repoId: id,
        environment: z.string().min(1).max(40).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }) => listPlans(ctx, input)),

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

  /** Plan + apply the head of a branch now (production branch by default). */
  deploy: adminProcedure
    .input(z.object({ repoId: id, branch: z.string().min(1).max(200).optional() }))
    .mutation(({ ctx, input }) => replan(ctx, input)),

  /** Compare the last applied commit with live state (no changes made). */
  drift: orgProcedure
    .input(z.object({ repoId: id }))
    .query(({ ctx, input }) => detectDrift(ctx, input.repoId, { notify: false })),

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
});
