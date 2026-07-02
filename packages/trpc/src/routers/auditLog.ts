import { orgProcedure, router } from '../trpc';
import { overview } from '../services/auditLog.service';

/**
 * Audit pack — audit log querying, canned questions, export, retention (slice E5). Spine stub — slice E5 replaces the
 * placeholder `overview` procedure with the real surface.
 */
export const auditLogRouter = router({
  /** Inert placeholder so the mount + client types exist before the slice lands. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),
});
