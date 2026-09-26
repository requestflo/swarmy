import { SetCostBudgetInput, SetNodeCostInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { overview, recommendations, setNodeCost, storage } from '../services/cost.service';
import { getBudget, sendWeeklySummaryNow, setBudget } from '../services/cost-budget.service';

/**
 * Cost & capacity (slice F1) — node monthly prices (`swarmy.node.cost` label),
 * live utilization, per-stack estimated spend, idle/oversized detection and
 * the recommendations feed. Pricing is Docker-truth; history comes from
 * MetricSample. The one DB row is the workspace budget (owner decision Q6):
 * monthly budget, the warn-at % (the cost-budget alert rule's threshold) and
 * the weekly cost summary settings.
 */
export const costRouter = router({
  /** Nodes + totals + per-stack estimates + idle/oversized (poll for live data). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Garage bucket usage + registered cluster-volume count. */
  storage: orgProcedure.query(({ ctx }) => storage(ctx)),

  /** Human-readable saving/setup nudges with rough monthly guesses. */
  recommendations: orgProcedure.query(({ ctx }) => recommendations(ctx)),

  /** Set (or clear) a node's monthly price — writes the node label; audited. */
  setNodeCost: orgProcedure
    .input(SetNodeCostInput)
    .mutation(({ ctx, input }) => setNodeCost(ctx, input)),

  /** The workspace budget, where the month stands and the weekly summary settings. */
  budget: orgProcedure.query(({ ctx }) => getBudget(ctx)),

  /** Set/clear the budget, the warn-at % (cost-budget rule threshold) and the weekly summary; audited. */
  setBudget: orgProcedure
    .input(SetCostBudgetInput)
    .mutation(({ ctx, input }) => setBudget(ctx, input)),

  /** Send the weekly cost summary now through its channels (a test; the weekly clock doesn't move). */
  sendWeeklySummaryNow: orgProcedure.mutation(({ ctx }) => sendWeeklySummaryNow(ctx)),
});
