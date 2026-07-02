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
import { orgProcedure, router } from '../trpc';
import {
  approveRun,
  cancelRun,
  createDef,
  getRun,
  listDefs,
  listRuns,
  listVersions,
  overview,
  rejectRun,
  removeDef,
  setEnabled,
  triggerWorkflow,
  updateDef,
} from '../services/workflows.service';

/**
 * Workflow engine (slice B3) — versioned step definitions, sequential runs
 * advanced by the workflow-runner worker, approvals, cancel, history.
 */
export const workflowEngineRouter = router({
  /** Counts for the Workflows page hero (defs, live runs, 24h outcomes). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Latest version per workflow name, with steps and last-run status. */
  defs: orgProcedure.query(({ ctx }) => listDefs(ctx)),

  /** Full version history for one workflow name (newest first). */
  versions: orgProcedure
    .input(WorkflowDefRefInput)
    .query(({ ctx, input }) => listVersions(ctx, input.name)),

  /** Run history, newest first (optionally one definition's; paginated). */
  runs: orgProcedure.input(WorkflowRunsInput).query(({ ctx, input }) => listRuns(ctx, input)),

  /** One run with its full step timeline and approval context. */
  run: orgProcedure.input(WorkflowRunRefInput).query(({ ctx, input }) => getRun(ctx, input.runId)),

  /** Create version 1 of a workflow (steps validated; audited). */
  create: orgProcedure
    .input(CreateWorkflowDefInput)
    .mutation(({ ctx, input }) => createDef(ctx, input)),

  /** Edit = a new version row; history stays intact (audited). */
  update: orgProcedure
    .input(UpdateWorkflowDefInput)
    .mutation(({ ctx, input }) => updateDef(ctx, input)),

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
    .mutation(({ ctx, input }) => triggerWorkflow(ctx, input)),

  /** Cancel an active run (in-flight step completion becomes a no-op). */
  cancel: orgProcedure
    .input(WorkflowRunRefInput)
    .mutation(({ ctx, input }) => cancelRun(ctx, input.runId)),

  /** Approve the waiting approval step — the run resumes (audited). */
  approve: orgProcedure
    .input(WorkflowDecisionInput)
    .mutation(({ ctx, input }) => approveRun(ctx, input)),

  /** Reject the waiting approval step — the run fails (audited). */
  reject: orgProcedure
    .input(WorkflowDecisionInput)
    .mutation(({ ctx, input }) => rejectRun(ctx, input)),
});
