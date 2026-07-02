import { orgProcedure, router } from '../trpc';
import { overview } from '../services/exposure.service';

/**
 * Exposure — public/private/protected audit of every service + exposure rules (slice E3). Spine stub — slice E3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const exposureRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
