import { orgProcedure, router } from '../trpc';
import { overview } from '../services/workflows.service';

/**
 * Workflow engine — versioned step definitions, sequential runs, approvals (slice B3). Spine stub — slice B3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const workflowEngineRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
