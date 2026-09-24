import { z } from 'zod';
import {
  CreateWorkflowDefInput,
  TriggerWorkflowInput,
  UpdateWorkflowDefInput,
  WorkflowDecisionInput,
  WorkflowDefRefInput,
  WorkflowRunRefInput,
  WorkflowRunsInput,
} from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { authorize, resolveService } from '../abac';
import type { OrgContext } from '../context';
import {
  approveRun,
  cancelRun,
  createDef,
  getRun,
  listDefs,
  listRuns,
  listVersions,
  overview,
  parseSteps,
  rejectRun,
  removeDef,
  setEnabled,
  triggerWorkflow,
  updateDef,
} from '../services/workflows.service';

/**
 * Workflow engine (slice B3) — versioned step definitions, sequential runs
 * advanced by the workflow-runner worker, approvals, cancel, history.
 * Stack-scoped IA: list/overview take an optional `stack`; defs carry a
 * `stackName` home so the stack workspace Messaging tab can filter.
 */

/** Optional stack scope for list/overview procedures (no input = org-wide). */
const StackScopeInput = z.object({ stack: z.string().min(1).optional() }).optional();

const stackNameField = z.string().min(1).max(63).optional();

/**
 * Workflow steps run code: a `service-exec` step execs into a live service
 * (its output lands in the readable run timeline) — shell power, so it needs
 * `terminal.open` on that service; a `container` step runs a one-shot
 * container (`service.deploy`). Checked when steps are written (create/update)
 * and when a run starts (trigger), so a member can't reach prod through it.
 */
async function authorizeSteps(
  ctx: OrgContext,
  steps: ReadonlyArray<{ kind: string; config?: { serviceRef?: string | null } | null }>,
): Promise<void> {
  const refs = new Set<string>();
  let container = false;
  for (const step of steps) {
    if (step.kind === 'service-exec') refs.add(step.config?.serviceRef ?? '');
    else if (step.kind === 'container') container = true;
  }
  for (const ref of refs) {
    const resource = ref ? await resolveService(ctx, { id: ref }) : null;
    await authorize(ctx, 'terminal.open', resource);
  }
  if (container) await authorize(ctx, 'service.deploy', null);
}

/** The def a trigger would run (org-scoped); `null` lets the service 404. */
async function defToRun(ctx: OrgContext, input: { defId?: string; name?: string }) {
  if (input.defId) {
    return ctx.db.workflowDef.findFirst({
      where: { id: input.defId, orgId: ctx.activeOrgId },
      select: { stepsJson: true },
    });
  }
  if (!input.name) return null;
  return ctx.db.workflowDef.findFirst({
    where: { name: input.name, orgId: ctx.activeOrgId },
    orderBy: { version: 'desc' },
    select: { stepsJson: true },
  });
}

export const workflowEngineRouter = router({
  /** Counts for the Workflows hero (defs, live runs, 24h outcomes). */
  overview: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => overview(ctx, input?.stack)),

  /** Latest version per workflow name, with steps and last-run status. */
  defs: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => listDefs(ctx, input?.stack)),

  /** Full version history for one workflow name (newest first). */
  versions: orgProcedure
    .input(WorkflowDefRefInput)
    .query(({ ctx, input }) => listVersions(ctx, input.name)),

  /** Run history, newest first (optionally one def's / one stack's; paginated). */
  runs: orgProcedure
    .input(WorkflowRunsInput.extend({ stack: z.string().min(1).optional() }))
    .query(({ ctx, input }) => listRuns(ctx, input)),

  /** One run with its full step timeline and approval context. */
  run: orgProcedure.input(WorkflowRunRefInput).query(({ ctx, input }) => getRun(ctx, input.runId)),

  /** Create version 1 of a workflow (steps validated; audited). */
  create: orgProcedure
    .input(CreateWorkflowDefInput.extend({ stackName: stackNameField }))
    .mutation(async ({ ctx, input }) => {
      await authorizeSteps(ctx, input.steps);
      return createDef(ctx, input);
    }),

  /** Edit = a new version row; history stays intact (audited). */
  update: orgProcedure
    .input(UpdateWorkflowDefInput.extend({ stackName: stackNameField }))
    .mutation(async ({ ctx, input }) => {
      await authorizeSteps(ctx, input.steps);
      return updateDef(ctx, input);
    }),

  /** Enable/disable triggering across all versions of the name (audited). */
  setEnabled: orgProcedure
    .input(z.object({ name: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input)),

  /** Delete every version of the name and its run history (audited). */
  remove: orgProcedure
    .input(WorkflowDefRefInput)
    .mutation(({ ctx, input }) => removeDef(ctx, input.name)),

  /** Start a run (by def id or latest of name) — the runner advances it. */
  trigger: orgProcedure
    .input(TriggerWorkflowInput)
    .mutation(async ({ ctx, input }) => {
      const def = await defToRun(ctx, input);
      if (def) await authorizeSteps(ctx, parseSteps(def.stepsJson));
      return triggerWorkflow(ctx, input);
    }),

  /** Cancel an active run (in-flight step completion becomes a no-op). */
  cancel: orgProcedure
    .input(WorkflowRunRefInput)
    .mutation(({ ctx, input }) => cancelRun(ctx, input.runId)),

  /** Approve the waiting approval step — the run resumes (audited). */
  approve: adminProcedure
    .input(WorkflowDecisionInput)
    .mutation(({ ctx, input }) => approveRun(ctx, input)),

  /** Reject the waiting approval step — the run fails (audited). */
  reject: adminProcedure
    .input(WorkflowDecisionInput)
    .mutation(({ ctx, input }) => rejectRun(ctx, input)),
});
