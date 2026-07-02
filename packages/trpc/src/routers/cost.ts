import { orgProcedure, router } from '../trpc';
import { overview } from '../services/cost.service';

/**
 * Cost — node cost labels, utilization, per-stack share, recommendations (slice F1). Spine stub — slice F1 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const costRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
