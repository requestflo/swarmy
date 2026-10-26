import { orgProcedure, router } from '../trpc';
import { getDashboardSummary, getOverview } from '../services/metrics.service';
import { estateUptime } from '../services/estate-uptime';

/** Estate-wide rollups: the Overview summary and the live cluster gauge. */
export const estateRouter = router({
  /** Nodes, services and health counts for the Overview page and the shell. */
  summary: orgProcedure.query(({ ctx }) => getDashboardSummary(ctx)),
  /** Live CPU / memory / node / container gauge (Infrastructure hero). */
  overview: orgProcedure.query(({ ctx }) => getOverview(ctx)),
  /**
   * The estate's uptime over 30 days: the share of the time every app
   * answered, from status checks or else the edges' requests (and which), or
   * "not enough data". Never a made-up 100%.
   */
  uptime: orgProcedure.query(({ ctx }) => estateUptime(ctx)),
});
