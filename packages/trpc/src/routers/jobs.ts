import { z } from 'zod';
import {
  CreateScheduledJobInput,
  JobRunsInput,
  PreviewScheduleInput,
  UpdateScheduledJobInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  cancelRun,
  createJob,
  listJobs,
  listRuns,
  overview,
  previewSchedule,
  removeJob,
  runNow,
  toggleJob,
  updateJob,
} from '../services/jobs.service';

/** Optional stack scope for list/overview procedures (no input = org-wide). */
const StackScopeInput = z.object({ stack: z.string().min(1).optional() }).optional();

const stackNameField = z.string().min(1).max(63).optional();

/**
 * Scheduled jobs (slice B2) — user cron firing one-shot containers
 * (`container.runOnce`) or service execs, with run history and output tails.
 * Stack-scoped IA: list/overview take an optional `stack`; jobs carry a
 * `stackName` home so the stack workspace Messaging tab can filter.
 */
export const jobsRouter = router({
  /** Counts + the soonest upcoming run, for the Jobs page hero. */
  overview: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => overview(ctx, input?.stack)),

  /** Every job with schedule text, last-run status and next occurrence. */
  list: orgProcedure
    .input(StackScopeInput)
    .query(({ ctx, input }) => listJobs(ctx, input?.stack)),

  /** Validate a cron + return its next occurrences (live editor preview). */
  previewSchedule: orgProcedure
    .input(PreviewScheduleInput)
    .query(({ input }) => previewSchedule(input)),

  /** Run history for one job (cursor-paginated, newest first). */
  runs: orgProcedure.input(JobRunsInput).query(({ ctx, input }) => listRuns(ctx, input)),

  /** Create a job (cron validated server-side; audited). */
  create: orgProcedure
    .input(CreateScheduledJobInput.extend({ stackName: stackNameField }))
    .mutation(({ ctx, input }) => createJob(ctx, input)),

  /** Update a job (merged config re-validated; audited). */
  update: orgProcedure
    .input(UpdateScheduledJobInput.extend({ stackName: stackNameField }))
    .mutation(({ ctx, input }) => updateJob(ctx, input)),

  /** Delete a job and its run history (audited). */
  remove: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => removeJob(ctx, input.id)),

  /** Pause/resume the schedule without losing the job (audited). */
  toggle: orgProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => toggleJob(ctx, input)),

  /** Fire immediately; returns the run id, the UI polls `runs` (audited). */
  runNow: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => runNow(ctx, input.id)),

  /** Best-effort cancel of a running attempt (audited). */
  cancelRun: orgProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(({ ctx, input }) => cancelRun(ctx, input.runId)),
});
