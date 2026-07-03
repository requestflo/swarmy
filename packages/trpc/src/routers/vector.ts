import { z } from 'zod';
import { AttachVectorInput, EnablePgvectorInput, ProvisionVectorInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachVectorToService,
  destroyVector,
  detachVectorFromService,
  enablePgvector,
  getVectorInstance,
  listPgvectorClusters,
  listVectorInstances,
  provisionVector,
  vectorStats,
} from '../services/vector.service';

const instanceRef = z.object({
  stack: z.string().min(1).max(63),
  name: z.string().min(1).max(40),
});

const listInput = z.object({ stack: z.string().min(1).max(63).optional() }).optional();

/**
 * Vector store (slice F5) — managed qdrant instances (Docker-truth via
 * `swarmy.vector.*` labels, API key in a Docker secret) plus pgvector
 * enablement on existing managed Postgres clusters.
 */
export const vectorStoreRouter = router({
  /** Provision a qdrant instance. Returns the API key ONCE — never again. */
  provision: orgProcedure
    .input(ProvisionVectorInput)
    .mutation(({ ctx, input }) => provisionVector(ctx, input)),

  /** Managed qdrant instances — the whole org, or one stack when `stack` is given. */
  list: orgProcedure
    .input(listInput)
    .query(({ ctx, input }) => listVectorInstances(ctx, input?.stack)),

  /** One instance's view, read straight off the labels. */
  get: orgProcedure.input(instanceRef).query(({ ctx, input }) => getVectorInstance(ctx, input)),

  /** Remove the service + key secret. Blocked while apps are attached. */
  destroy: orgProcedure
    .input(instanceRef.extend({ force: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => destroyVector(ctx, input)),

  /** Wire an app: QDRANT_URL + API-key secret ref + instance network. */
  attachToService: orgProcedure
    .input(AttachVectorInput)
    .mutation(({ ctx, input }) => attachVectorToService(ctx, input)),

  /** Unwire an app (drops env, secret ref, network and inject labels). */
  detach: orgProcedure
    .input(instanceRef.extend({ appService: z.string().min(1) }))
    .mutation(({ ctx, input }) => detachVectorFromService(ctx, input)),

  /** Live collections sample (falls back to the reconcile stamp). */
  stats: orgProcedure.input(instanceRef).query(({ ctx, input }) => vectorStats(ctx, input)),

  /** Managed Postgres clusters + their pgvector state (enablement rows). */
  pgvector: orgProcedure
    .input(listInput)
    .query(({ ctx, input }) => listPgvectorClusters(ctx, input?.stack)),

  /** `CREATE EXTENSION IF NOT EXISTS vector` on a cluster primary + stamp. */
  enablePgvector: orgProcedure
    .input(EnablePgvectorInput)
    .mutation(({ ctx, input }) => enablePgvector(ctx, input)),
});
