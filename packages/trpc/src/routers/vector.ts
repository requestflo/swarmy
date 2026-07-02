import { orgProcedure, router } from '../trpc';
import { overview } from '../services/vector.service';

/**
 * Vector store — Qdrant / pgvector, Docker-truth via `swarmy.vector.*` labels (slice F5). Spine stub — slice F5 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const vectorStoreRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
