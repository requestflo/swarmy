import { z } from 'zod';
import {
  AttachSearchInput,
  ProvisionSearchInput,
  SearchIndexRef,
  SearchInstanceRef,
  SearchQueryInput,
  SetIndexSettingsInput,
  SwapSearchIndexInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import { abacProcedure, resolveStackByName, resolveStackService } from '../abac';
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
import { searchIndex, searchIndexes, searchQuery } from '../services/search-indexes.service';
import { setSearchIndexSettings } from '../services/search-index-settings.service';
import { rotateSearchKey } from '../services/search-key.service';
import { swapSearchIndex } from '../services/search-swap.service';

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
  provision: abacProcedure('stack.deploy', resolveStackByName)
    .input(ProvisionSearchInput)
    .mutation(({ ctx, input }) => provisionSearch(ctx, input)),

  /** Managed search instances — the whole org, or one stack when `stack` is given. */
  list: orgProcedure
    .input(z.object({ stack: stackName.optional() }).optional())
    .query(({ ctx, input }) => listSearchInstances(ctx, input?.stack)),

  /** One instance's view, read straight off the labels. */
  get: orgProcedure.input(instanceRef).query(({ ctx, input }) => getSearchInstance(ctx, input)),

  /** Remove the service + the key secret. Blocked while apps are attached. */
  destroy: abacProcedure('data.destroy')
    .input(instanceRef.extend({ force: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => destroySearch(ctx, input)),

  /** Wire an app: MEILI_HOST/TYPESENSE_* env + key secret ref + network. */
  attachToService: abacProcedure('service.configure', resolveStackService)
    .input(AttachSearchInput)
    .mutation(({ ctx, input }) => attachSearchToService(ctx, input)),

  /** Unwire an app (drops env, secret ref, network and inject labels). */
  detach: abacProcedure('service.configure', resolveStackService)
    .input(instanceRef.extend({ appService: z.string().min(1) }))
    .mutation(({ ctx, input }) => detachSearchFromService(ctx, input)),

  /** Live stats sample (docs/indexes) — falls back to the reconcile stamp. */
  stats: orgProcedure.input(instanceRef).query(({ ctx, input }) => searchStats(ctx, input)),

  /** Engine dump (meilisearch) + restic snapshot of the data volume. */
  backup: orgProcedure
    .input(instanceRef.extend({ targetId: z.string().min(1).optional() }))
    .mutation(({ ctx, input }) => backupSearch(ctx, input)),

  /** Stop engine → restore volume → start engine. */
  restore: abacProcedure('data.restore')
    .input(
      instanceRef.extend({
        snapshotId: z.string().min(1),
        targetId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => restoreSearch(ctx, input)),

  /** Every index (documents, size, last change), read from the engine inside its container. Audited. */
  indexes: orgProcedure.input(SearchInstanceRef).query(({ ctx, input }) => searchIndexes(ctx, input)),

  /** One index with its searchable / filterable / sortable fields and synonyms. Audited. */
  index: orgProcedure.input(SearchIndexRef).query(({ ctx, input }) => searchIndex(ctx, input)),

  /**
   * "Try it": the top 5 hits for a query and the engine's time. The hits are
   * the app's documents, so the service gates it `data.read` on the stack and
   * records one `search.query` audit row (the deciding policy included).
   */
  query: orgProcedure.input(SearchQueryInput).query(({ ctx, input }) => searchQuery(ctx, input)),

  /**
   * Edit an index's searchable fields, filters and synonyms (only the lists
   * given). Changes how the app's search behaves, so it is gated like a
   * deploy (`stack.deploy` on the stack); audited `search.index.settings`.
   */
  setIndexSettings: abacProcedure('stack.deploy', resolveStackByName)
    .input(SetIndexSettingsInput)
    .mutation(({ ctx, input }) => setSearchIndexSettings(ctx, input)),

  /**
   * Reindex by swap: swap a rebuilt index (the app wrote every document into
   * it) in for the live one, atomically. swarmy holds no app data, so this is
   * the reindex it can do. Refused when the rebuild is empty, still filling or
   * keyed differently. Typed confirmation; gated like a settings edit
   * (`stack.deploy`); audited `search.index.swap`.
   */
  swapIndex: abacProcedure('stack.deploy', resolveStackByName)
    .input(SwapSearchIndexInput)
    .mutation(({ ctx, input }) => swapSearchIndex(ctx, input)),

  /**
   * Rotate the master key: a new `…-key__v<n>` secret, the engine restarted
   * on it, every attached app moved onto it at the same file path, old
   * versions removed. Returns the new key ONCE. Gated like
   * db.rotatePassword (`secret.delete`); audited `search.key.rotate`.
   */
  rotateKey: abacProcedure('secret.delete', resolveStackByName)
    .input(SearchInstanceRef)
    .mutation(({ ctx, input }) => rotateSearchKey(ctx, input)),

  /** Snapshots for this instance (restic catalog filtered by the search tag). */
  listBackups: orgProcedure
    .input(instanceRef.extend({ targetId: z.string().min(1).optional() }))
    .query(({ ctx, input }) => listSearchBackups(ctx, input)),
});
