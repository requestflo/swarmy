import { orgProcedure, router } from '../trpc';
import { overview } from '../services/guardrails.service';

/**
 * Guardrails — production safety rules enforced at deploy admission (slice E4). Spine stub — slice E4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const guardrailsRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
