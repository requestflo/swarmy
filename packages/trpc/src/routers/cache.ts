import { z } from 'zod';
import { AttachCacheInput, ProvisionCacheInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachCacheToService,
  backupCache,
  cacheStats,
  destroyCache,
  detachCacheFromService,
  getCacheCluster,
  listCacheBackups,
  listCacheClusters,
  provisionCache,
  restoreCache,
  setCacheMemory,
  setCacheReplicas,
} from '../services/cache.service';

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

const clusterRef = z.object({ stack: stackName, cluster: clusterName });

/**
 * Managed cache (slice A3) — Valkey/Redis clusters, Docker-truth via
 * `swarmy.cache.*` labels (mirrors manageddb). Private-only, password in a
 * Docker secret, converged by the cache-reconcile worker.
 */
export const managedCacheRouter = router({
  /** Provision a cluster. Returns the generated password ONCE — never again. */
  provision: orgProcedure
    .input(ProvisionCacheInput)
    .mutation(({ ctx, input }) => provisionCache(ctx, input)),

  /** Every managed cache cluster in the org (the Data → Caches list). */
  list: orgProcedure.query(({ ctx }) => listCacheClusters(ctx)),

  /** One cluster's topology view, read straight off the labels. */
  get: orgProcedure.input(clusterRef).query(({ ctx, input }) => getCacheCluster(ctx, input)),

  /** Scale read replicas to N (sentinel topology holds a floor of 1). */
  setReplicas: orgProcedure
    .input(clusterRef.extend({ replicas: z.number().int().min(0).max(10) }))
    .mutation(({ ctx, input }) => setCacheReplicas(ctx, input)),

  /** Change maxmemory (MB) — redeploys members with the new limit. */
  setMemory: orgProcedure
    .input(clusterRef.extend({ memoryMb: z.number().int().min(64).max(65536) }))
    .mutation(({ ctx, input }) => setCacheMemory(ctx, input)),

  /** Remove every member + the password secret. Blocked while apps are attached. */
  destroy: orgProcedure
    .input(clusterRef.extend({ force: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => destroyCache(ctx, input)),

  /** Wire an app: REDIS_URL + password secret ref + cluster network. */
  attachToService: orgProcedure
    .input(AttachCacheInput)
    .mutation(({ ctx, input }) => attachCacheToService(ctx, input)),

  /** Unwire an app (drops env, secret ref, network and inject labels). */
  detach: orgProcedure
    .input(clusterRef.extend({ appService: z.string().min(1) }))
    .mutation(({ ctx, input }) => detachCacheFromService(ctx, input)),

  /** Live INFO sample from the primary (falls back to the reconcile stamp). */
  stats: orgProcedure.input(clusterRef).query(({ ctx, input }) => cacheStats(ctx, input)),

  /** BGSAVE + restic snapshot of the data volume (tag `cache:<cluster>`). */
  backup: orgProcedure
    .input(clusterRef.extend({ targetId: z.string().min(1).optional() }))
    .mutation(({ ctx, input }) => backupCache(ctx, input)),

  /** Stop primary → restore volume → start primary. */
  restore: orgProcedure
    .input(
      clusterRef.extend({
        snapshotId: z.string().min(1),
        targetId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreCache(ctx, input)),

  /** Snapshots for this cluster (restic catalog filtered by the cache tag). */
  listBackups: orgProcedure
    .input(clusterRef.extend({ targetId: z.string().min(1).optional() }))
    .query(({ ctx, input }) => listCacheBackups(ctx, input)),
});
