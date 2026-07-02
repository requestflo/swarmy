import { orgProcedure, router } from '../trpc';
import { overview } from '../services/releases.service';

/**
 * Releases & deploy safety — release history, health gates, rollback (slice D1). Spine stub — slice D1 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const releasesRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
