import { orgProcedure, router } from '../trpc';
import { overview } from '../services/jobs.service';

/**
 * Scheduled jobs — cron-fired one-shot containers / service execs (`ScheduledJob`/`JobRun`) (slice B2). Spine stub — slice B2 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const jobsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
