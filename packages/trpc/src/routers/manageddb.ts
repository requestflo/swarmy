import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import {
  getDbTopology,
  injectConnection,
  provisionDb,
  setReplicas,
} from '../services/manageddb.service';

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
 * Managed DB topology (epic #8). Declare a Postgres primary/replica cluster for
 * a stack, read its live health, scale replicas, and inject the connection env
 * into an app service — all Docker-truth (labels), no new Prisma model.
 */
export const managedDbRouter = router({
  /** Provision a cluster (deploy primary + N replicas, stamp swarmy.db.* labels). */
  provision: orgProcedure
    .input(
      z.object({
        stack: stackName,
        name: clusterName,
        engine: z.literal('postgres').default('postgres'),
        replicas: z.number().int().min(0).max(20),
        password: z.string().min(8).max(128).optional(),
        database: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[A-Za-z0-9_]+$/, 'invalid database name')
          .optional(),
        imageTag: z.string().min(1).max(40).optional(),
      }),
    )
    .mutation(({ ctx, input }) => provisionDb(ctx, input)),

  /** Read the managed-DB topology for a stack (clusters + health + rw/ro hosts). */
  get: orgProcedure
    .input(z.object({ stack: stackName }))
    .query(({ ctx, input }) => getDbTopology(ctx, input.stack)),

  /** Scale a cluster's read replicas to N. */
  setReplicas: orgProcedure
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        replicas: z.number().int().min(0).max(20),
      }),
    )
    .mutation(({ ctx, input }) => setReplicas(ctx, input)),

  /** Inject DATABASE_URL (+ *_RO_URL) env onto an app service in the stack. */
  inject: orgProcedure
    .input(
      z.object({
        stack: stackName,
        appService: z.string().min(1),
        cluster: clusterName,
        envVar: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env var name')
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => injectConnection(ctx, input)),
});
