import { z } from 'zod';
import { orgProcedure } from '../trpc';
import { abacProcedure, resolveStackByName } from '../abac';
import { getDbSwitchoverRun, startDbSwitchover } from '../services/manageddb-switchover.start';

const stackName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name');

const clusterName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid cluster name');

/**
 * The planned switchover's procedures, spread into `db.*` (routers/manageddb.ts).
 */
export const switchoverProcedures = {
  /**
   * Hand the writes to a caught-up standby copy (`target`, a member service)
   * or the most caught-up one, losing nothing: writes pause for a few
   * seconds while the copy replays the main copy's final change, then the
   * reconcile promotes it, repoints the other copies and the pooler, and the
   * old main copy follows as a standby. A refusal (the copy is behind, an app
   * connects straight to the main copy, …) is the error, before anything is
   * touched. The closest data action, `data.failover` (owner/admin by
   * default); audited `db.switchover.start` / `db.switchover` / `.abort`.
   */
  switchover: abacProcedure('data.failover', resolveStackByName)
    .input(z.object({ stack: stackName, cluster: clusterName, target: z.string().min(1).max(200).optional() }))
    .mutation(({ ctx, input }) => startDbSwitchover(ctx, input)),

  /** The cluster's switchover in flight (or its last one, for ten minutes): each step and its words. */
  switchoverRun: orgProcedure
    .input(z.object({ stack: stackName, cluster: clusterName }))
    .query(({ ctx, input }) => getDbSwitchoverRun(ctx, input)),
};
