import { orgProcedure, router } from '../trpc';
import { getDashboardSummary } from '../services/metrics.service';

export const systemRouter = router({
  dashboardSummary: orgProcedure.query(({ ctx }) => getDashboardSummary(ctx)),
});
