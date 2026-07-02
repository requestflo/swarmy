import { z } from 'zod';
import { AttachSearchInput, ProvisionSearchInput } from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachSearchToService,
  backupSearch,
  destroySearch,
  detachSearchFromService,
  getSearchInstance,
  listSearchBackups,
  listSearchInstances,
  provisionSearch,
  restoreSearch,
  searchStats,
} from '../services/search.service';

const stackName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name');

const instanceName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid instance name');

const instanceRef = z.object({ stack: stackName, name: instanceName });

/**
 * Managed search (slice F4) — Meilisearch/Typesense instances, Docker-truth
 * via `swarmy.search.*` labels (mirrors the managed-cache slice, single-node).
 * Private-only, master key in a Docker secret, watched by search-reconcile.
 */
export const managedSearchRouter = router({
  /** Provision an instance. Returns the generated master key ONCE — never again. */
  provision: orgProcedure
    .input(ProvisionSearchInput)
    .mutation(({ ctx, input }) => provisionSearch(ctx, input)),

  /** Every managed search instance in the org (the Data → Search list). */
  list: orgProcedure.query(({ ctx }) => listSearchInstances(ctx)),

  /** One instance's view, read straight off the labels. */
  get: orgProcedure.input(instanceRef).query(({ ctx, input }) => getSearchInstance(ctx, input)),

  /** Remove the service + the key secret. Blocked while apps are attached. */
  destroy: orgProcedure
    .input(instanceRef.extend({ force: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => destroySearch(ctx, input)),

  /** Wire an app: MEILI_HOST/TYPESENSE_* env + key secret ref + network. */
  attachToService: orgProcedure
    .input(AttachSearchInput)
    .mutation(({ ctx, input }) => attachSearchToService(ctx, input)),

  /** Unwire an app (drops env, secret ref, network and inject labels). */
  detach: orgProcedure
    .input(instanceRef.extend({ appService: z.string().min(1) }))
    .mutation(({ ctx, input }) => detachSearchFromService(ctx, input)),

  /** Live stats sample (docs/indexes) — falls back to the reconcile stamp. */
  stats: orgProcedure.input(instanceRef).query(({ ctx, input }) => searchStats(ctx, input)),

  /** Engine dump (meilisearch) + restic snapshot of the data volume. */
  backup: orgProcedure
    .input(instanceRef.extend({ targetId: z.string().min(1).optional() }))
    .mutation(({ ctx, input }) => backupSearch(ctx, input)),

  /** Stop engine → restore volume → start engine. */
  restore: orgProcedure
    .input(
      instanceRef.extend({
        snapshotId: z.string().min(1),
        targetId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreSearch(ctx, input)),

  /** Snapshots for this instance (restic catalog filtered by the search tag). */
  listBackups: orgProcedure
    .input(instanceRef.extend({ targetId: z.string().min(1).optional() }))
    .query(({ ctx, input }) => listSearchBackups(ctx, input)),
});
