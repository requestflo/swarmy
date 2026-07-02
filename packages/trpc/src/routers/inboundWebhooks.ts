import { orgProcedure, router } from '../trpc';
import { overview } from '../services/inboundWebhooks.service';

/**
 * Inbound webhook gateway — public endpoints, verified deliveries, retry/replay/DLQ (slice B4). Spine stub — slice B4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const inboundWebhooksRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
