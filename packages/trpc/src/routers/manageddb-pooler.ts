import { z } from 'zod';
import { POOLER_MODES, POOLER_POOL_MAX, POOLER_POOL_MIN } from '@swarmy/core';
import { abacProcedure, resolveStackByName } from '../abac';
import { setDbPooler } from '../services/manageddb-pooler.service';

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
 * The managed Postgres pooler's procedures, spread into `db.*`
 * (routers/manageddb.ts): declare it, read it, wire an app through it.
 */
export const poolerProcedures = {
  /**
   * Turn the PgBouncer pooler on or off, or change its mode / pool size:
   * rewrites `swarmy.db.pooler` on the primary; the reconcile creates,
   * updates or removes `<stack>_<cluster>-pooler`. Gate `stack.deploy`, like
   * the other declare-and-converge changes; audited `db.pooler.set`.
   */
  setPooler: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        enabled: z.boolean(),
        mode: z.enum(POOLER_MODES).optional(),
        poolSize: z.number().int().min(POOLER_POOL_MIN).max(POOLER_POOL_MAX).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setDbPooler(ctx, input)),
};
