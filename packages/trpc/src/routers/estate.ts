import { orgProcedure, router } from '../trpc';
import { getDashboardSummary, getOverview } from '../services/metrics.service';

/** Estate-wide rollups: the Overview summary and the live cluster gauge. */
export const estateRouter = router({
  /** Nodes, services and health counts for the Overview page and the shell. */
  summary: orgProcedure.query(({ ctx }) => getDashboardSummary(ctx)),
  /** Live CPU / memory / node / container gauge (Infrastructure hero). */
  overview: orgProcedure.query(({ ctx }) => getOverview(ctx)),
});
