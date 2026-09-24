import { z } from 'zod';
import { FILTER_OPS } from '@swarmy/core/studio';
import { StudioEngine } from '@swarmy/core/protocol';
import { orgProcedure, router } from '../trpc';
import {
  executeStudio,
  listSavedQueries,
  listStudioTargets,
  prepareEdit,
  previewStudio,
  removeSavedQuery,
  saveQuery,
  studioBrowse,
  studioCollection,
  studioHistory,
  studioInsights,
  studioKeys,
  studioKeyValue,
  studioSchema,
} from '../services/studio.service';

/**
 * Database studio, mounted as `studio`. Every procedure is `orgProcedure` on
 * purpose: the policy action depends on the STATEMENT (read → `data.read`,
 * write → `data.write`, destructive → `data.destroy` + typed confirm), so the
 * service classifies first and then gates through the same `evaluateAccess` /
 * `authorize` seam `abacProcedure` uses, with the DB service as the resource.
 * Every run is audited as `studio.query`.
 */
const ref = { stack: z.string().min(1), target: z.string().min(1) };
const database = z.string().regex(/^[A-Za-z0-9_.$-]{1,128}$/).nullish();
const dbIndex = z.number().int().min(0).max(255).optional();
const table = z.object({ schema: z.string().max(128).nullish(), name: z.string().min(1).max(256) });
const value = z.union([z.string().max(1_000_000), z.number(), z.boolean(), z.null()]);
const valueMap = z.record(value);

const StudioEditInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update'), table, key: valueMap, set: valueMap }),
  z.object({ kind: z.literal('insert'), table, values: valueMap }),
  z.object({ kind: z.literal('delete'), table, key: valueMap }),
  z.object({ kind: z.literal('mongoUpdate'), collection: z.string().min(1), id: z.unknown(), set: z.record(z.unknown()), unset: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('mongoInsert'), collection: z.string().min(1), doc: z.record(z.unknown()) }),
  z.object({ kind: z.literal('mongoDelete'), collection: z.string().min(1), id: z.unknown() }),
  z.object({ kind: z.literal('redisSet'), type: z.string(), key: z.string().min(1), field: z.string().nullable(), value: z.string().max(1_000_000) }),
  z.object({ kind: z.literal('redisRemove'), type: z.string(), key: z.string().min(1), member: z.string().nullable() }),
]);

export const studioRouter = router({
  /** The app's databases (managed Postgres clusters + compose DBs), live from Docker. */
  targets: orgProcedure.input(z.object({ stack: z.string().min(1) })).query(({ ctx, input }) => listStudioTargets(ctx, input.stack)),

  /** Tables/collections/keyspaces with columns, types and indexes. */
  schema: orgProcedure.input(z.object({ ...ref, database })).query(({ ctx, input }) => studioSchema(ctx, input)),

  /** Mongo: one collection's sampled fields, indexes and count. */
  collection: orgProcedure
    .input(z.object({ ...ref, database, collection: z.string().min(1) }))
    .query(({ ctx, input }) => studioCollection(ctx, input)),

  /** One page of rows / documents. */
  browse: orgProcedure
    .input(
      z.object({
        ...ref,
        database,
        table,
        page: z.number().int().min(0).max(1_000_000).default(0),
        pageSize: z.number().int().min(1).max(500).default(50),
        orderBy: z.string().max(256).nullish(),
        dir: z.enum(['asc', 'desc']).optional(),
        filters: z.array(z.object({ column: z.string().min(1).max(256), op: z.enum(FILTER_OPS), value: z.string().max(10_000).optional() })).max(10).optional(),
        mongoFilter: z.string().max(10_000).optional(),
      }),
    )
    .query(({ ctx, input }) => studioBrowse(ctx, input)),

  /** Redis/Valkey: one SCAN page with type / TTL / size. */
  keys: orgProcedure
    .input(z.object({ ...ref, dbIndex, pattern: z.string().max(512).optional(), cursor: z.string().regex(/^\d+$/).optional(), count: z.number().int().min(10).max(1000).optional() }))
    .query(({ ctx, input }) => studioKeys(ctx, input)),

  /** Redis/Valkey: one key's value. */
  keyValue: orgProcedure
    .input(z.object({ ...ref, dbIndex, key: z.string().min(1), type: z.string().max(32) }))
    .query(({ ctx, input }) => studioKeyValue(ctx, input)),

  /** The server's verdict on a statement (class, action, confirm phrase) — nothing runs. */
  preview: orgProcedure
    .input(z.object({ ...ref, statement: z.string().min(1).max(65_536) }))
    .query(({ ctx, input }) => previewStudio(ctx, input)),

  /** Build the exact statement a grid edit will run (shown before it applies). */
  prepareEdit: orgProcedure.input(z.object({ ...ref, edit: StudioEditInput })).mutation(({ ctx, input }) => prepareEdit(ctx, input)),

  /** Run one statement (console, confirmed edit, saved query). Gated + audited. */
  execute: orgProcedure
    .input(
      z.object({
        ...ref,
        statement: z.string().min(1).max(65_536),
        database,
        dbIndex,
        confirm: z.string().max(256).optional(),
        origin: z.enum(['console', 'edit', 'saved']).optional(),
      }),
    )
    .mutation(({ ctx, input }) => executeStudio(ctx, input)),

  /** Slow queries + what is running now, per engine; degrades with a reason and a hint. */
  insights: orgProcedure.input(z.object({ ...ref, database })).query(({ ctx, input }) => studioInsights(ctx, input)),

  /** My console runs on this database (from the audit log). */
  history: orgProcedure
    .input(z.object({ ...ref, limit: z.number().int().min(1).max(200).optional() }))
    .query(({ ctx, input }) => studioHistory(ctx, input)),

  saved: router({
    list: orgProcedure.input(z.object({ stack: z.string().min(1) })).query(({ ctx, input }) => listSavedQueries(ctx, input)),
    save: orgProcedure
      .input(
        z.object({
          stack: z.string().min(1),
          id: z.string().optional(),
          target: z.string().nullish(),
          engine: StudioEngine,
          name: z.string().min(1).max(120),
          statement: z.string().min(1).max(65_536),
        }),
      )
      .mutation(({ ctx, input }) => saveQuery(ctx, input)),
    remove: orgProcedure.input(z.object({ stack: z.string().min(1), id: z.string().min(1) })).mutation(({ ctx, input }) => removeSavedQuery(ctx, input)),
  }),
});
