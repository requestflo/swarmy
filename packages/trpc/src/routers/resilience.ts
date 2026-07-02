import { orgProcedure, router } from '../trpc';
import { overview } from '../services/resilience.service';

/**
 * Resilience — posture checks, score, safe failover/restore drills (slice F2). Spine stub — slice F2 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const resilienceRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
