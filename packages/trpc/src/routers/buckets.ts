import { orgProcedure, router } from '../trpc';
import { overview } from '../services/buckets.service';

/**
 * Object storage buckets — Garage bucket/key CRUD, quotas, usage, service attach (slice A4). Spine stub — slice A4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const objectStorageRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
