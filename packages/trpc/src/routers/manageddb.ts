import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import {
  DB_TOPOLOGIES,
  getDbTopology,
  injectConnection,
  provisionDb,
  setRegionReplicas,
  setReplicas,
  setTopology,
  setWriteRegion,
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

/** A node-label region value (`swarmy.region`) — same charset as a label value segment. */
const regionName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid region');

const topologyEnum = z.enum(DB_TOPOLOGIES);

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

  /**
   * Select (or change, in-situ) the cluster's HA topology. The reconcile worker
   * converges live infra to match — single | primary-replica | failover | geo |
   * active-active.
   */
  setTopology: orgProcedure
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        topology: topologyEnum,
        // geo: applied in one call so the UI fully provisions the geo shape.
        writeRegion: z.string().min(1).max(63).optional(),
        regions: z
          .array(z.object({ region: z.string().min(1).max(63), replicas: z.number().int().min(0).max(50) }))
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => setTopology(ctx, input)),

  /** Geo: pin the single writer to a node-label region (`swarmy.region==<region>`). */
  setWriteRegion: orgProcedure
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        region: regionName,
      }),
    )
    .mutation(({ ctx, input }) => setWriteRegion(ctx, input)),

  /** Geo: declare N read replicas pinned to a region (0 removes the region sibling). */
  setRegionReplicas: orgProcedure
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        region: regionName,
        replicas: z.number().int().min(0).max(20),
      }),
    )
    .mutation(({ ctx, input }) => setRegionReplicas(ctx, input)),

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
