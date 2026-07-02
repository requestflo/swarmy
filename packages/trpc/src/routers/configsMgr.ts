import { orgProcedure, router } from '../trpc';
import { overview } from '../services/configsMgr.service';

/**
 * Configs manager — Docker config families, edit/apply/rollback, restart preview (slice E2). Spine stub — slice E2 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const configsMgrRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
