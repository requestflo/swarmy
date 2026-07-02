import { orgProcedure, router } from '../trpc';
import { overview } from '../services/secretsMgr.service';

/**
 * Secrets manager — Docker secret families, versions, rotation, usage map (slice E1). Spine stub — slice E1 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const secretsMgrRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
