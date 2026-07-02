import { orgProcedure, router } from '../trpc';
import { overview } from '../services/previews.service';

/**
 * PR preview environments — `swarmy.preview.*` stacks with TTL + teardown (slice D4). Spine stub — slice D4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const previewsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
