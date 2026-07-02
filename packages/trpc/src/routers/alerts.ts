import { orgProcedure, router } from '../trpc';
import { overview } from '../services/alerts.service';

/**
 * Alerting — notification channels, alert rules, firing/resolved event feed (slice C3). Spine stub — slice C3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const alertsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
