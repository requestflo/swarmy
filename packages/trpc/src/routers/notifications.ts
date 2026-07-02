import { orgProcedure, router } from '../trpc';
import { overview } from '../services/notifications.service';

/**
 * Notifications — email provider config, templates, delivery log, test send (slice F6). Spine stub — slice F6 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const notificationsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
