import { SetNodeCostInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { overview, recommendations, setNodeCost, storage } from '../services/cost.service';

/**
 * Cost & capacity (slice F1) — node monthly prices (`swarmy.node.cost` label),
 * live utilization, per-stack estimated spend, idle/oversized detection and
 * the recommendations feed. Pricing is Docker-truth; history comes from
 * MetricSample; nothing cost-specific persists in the DB.
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
});
