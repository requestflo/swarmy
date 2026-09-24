import { z } from 'zod';
import {
  CreateScheduledJobInput,
  JobRunsInput,
  PreviewScheduleInput,
  UpdateScheduledJobInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { authorize, resolveService } from '../abac';
import type { OrgContext } from '../context';
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
 * A job runs code: a `service-exec` job execs into a live service (and its
 * output tail is readable) — the same power as a shell, so it needs
 * `terminal.open` on that service; an `image` job runs a one-shot container,
 * a deploy (`service.deploy`). Checked on create, update (merged with the
 * stored job) and runNow, so a member can't reach prod through the scheduler.
 */
async function authorizeJobTarget(
  ctx: OrgContext,
  job: { kind?: string | null; serviceRef?: string | null },
): Promise<void> {
  if (job.kind === 'service-exec' || job.kind === 'SERVICE_EXEC') {
    const resource = job.serviceRef ? await resolveService(ctx, { id: job.serviceRef }) : null;
    await authorize(ctx, 'terminal.open', resource);
  } else {
    await authorize(ctx, 'service.deploy', null);
  }
}

/** The stored job (org-scoped) for update/runNow; `null` lets the service 404. */
async function storedJob(ctx: OrgContext, id: string) {
  return ctx.db.scheduledJob.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { kind: true, serviceRef: true },
  });
}

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
    .mutation(async ({ ctx, input }) => {
      await authorizeJobTarget(ctx, input);
      return createJob(ctx, input);
    }),

  /** Update a job (merged config re-validated; audited). */
  update: orgProcedure
    .input(UpdateScheduledJobInput.extend({ stackName: stackNameField }))
    .mutation(async ({ ctx, input }) => {
      const row = await storedJob(ctx, input.id);
      if (row) {
        await authorizeJobTarget(ctx, {
          kind: input.kind ?? row.kind,
          serviceRef: input.serviceRef ?? row.serviceRef,
        });
      }
      return updateJob(ctx, input);
    }),

  /** Delete a job and its run history (audited). */
  remove: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => removeJob(ctx, input.id)),

  /** Pause/resume the schedule without losing the job (audited). */
  toggle: orgProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Resuming a schedule makes the job run again — same gate as runNow.
      if (input.enabled) {
        const row = await storedJob(ctx, input.id);
        if (row) await authorizeJobTarget(ctx, row);
      }
      return toggleJob(ctx, input);
    }),

  /** Fire immediately; returns the run id, the UI polls `runs` (audited). */
  runNow: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const row = await storedJob(ctx, input.id);
      if (row) await authorizeJobTarget(ctx, row);
      return runNow(ctx, input.id);
    }),

  /** Best-effort cancel of a running attempt (audited). */
  cancelRun: orgProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(({ ctx, input }) => cancelRun(ctx, input.runId)),
});
