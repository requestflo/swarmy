import { orgProcedure, router } from '../trpc';
import { overview } from '../services/incidents.service';

/**
 * Incidents — open/resolve lifecycle, event timeline, post-mortem notes (slice C4). Spine stub — slice C4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const incidentsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
