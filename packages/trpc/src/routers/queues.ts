import { orgProcedure, router } from '../trpc';
import { overview } from '../services/queues.service';

/**
 * Queues — queue defs in the `swarmy.queues` JSON label, depth stats, scaling, DLQ actions (slice B1). Spine stub — slice B1 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const queuesRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
