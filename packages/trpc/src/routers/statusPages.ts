import { orgProcedure, router } from '../trpc';
import { overview } from '../services/statusPages.service';

/**
 * Status pages — public component status, uptime history, incident feed (slice C5). Spine stub — slice C5 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const statusPagesRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
