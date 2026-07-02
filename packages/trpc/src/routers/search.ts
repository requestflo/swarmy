import { orgProcedure, router } from '../trpc';
import { overview } from '../services/search.service';

/**
 * Managed search — Meilisearch/Typesense, Docker-truth via `swarmy.search.*` labels (slice F4). Spine stub — slice F4 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const managedSearchRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
