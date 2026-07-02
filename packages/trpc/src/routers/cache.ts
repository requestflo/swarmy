import { orgProcedure, router } from '../trpc';
import { overview } from '../services/cache.service';

/**
 * Managed cache — Valkey/Redis clusters, Docker-truth via `swarmy.cache.*` labels (mirrors manageddb) (slice A3). Spine stub — slice A3 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const managedCacheRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
