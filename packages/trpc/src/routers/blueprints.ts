import { orgProcedure, router } from '../trpc';
import { overview } from '../services/blueprints.service';

/**
 * Blueprints — parameterized app catalog: list, plan (dry-run), deploy (slice F3). Spine stub — slice F3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const blueprintsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
