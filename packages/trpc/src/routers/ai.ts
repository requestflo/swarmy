import { orgProcedure, router } from '../trpc';
import { overview } from '../services/ai.service';

/**
 * AI gateway — provider configs, virtual keys, usage/cost, request log (slice F5). Spine stub — slice F5 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const aiGatewayRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
