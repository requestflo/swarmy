/**
 * `platform.bundle.*` — upload an offline platform bundle (`swarmy-<ver>.tar`)
 * from Settings › Platform: Begin → Chunk… → Finish, then poll Status while
 * the controller verifies it, loads its images into the built-in registry and
 * offers the release (`services/platform-bundle.service.ts`).
 *
 * Begin and Finish carry the gate every platform mutation has
 * (`authconfig.write`, each decision audited). Chunk and Status are bound to
 * that upload instead — its unguessable id, the org AND the person who began
 * it — so a 3 GB bundle doesn't write hundreds of permit rows. The load itself
 * is audited (`platform.bundle.load`, then `platform.release.import`).
 */
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  BUNDLE_CHUNK_BYTES,
  BUNDLE_MAX_BYTES,
  appendBundleChunk,
  beginBundleUpload,
  bundleUploadStatus,
  finishBundleUpload,
} from '../services/platform-bundle.service';

const ACTION = 'authconfig.write' as const;
const id = z.object({ id: z.string().uuid() });

export const platformBundleRouter = router({
  begin: abacProcedure(ACTION)
    .input(z.object({ name: z.string().min(1).max(500), size: z.number().int().positive().max(BUNDLE_MAX_BYTES) }))
    .mutation(async ({ ctx, input }) => ({ ...(await beginBundleUpload(ctx, input)), chunkBytes: BUNDLE_CHUNK_BYTES })),

  /** `data` is base64 of at most {@link BUNDLE_CHUNK_BYTES} raw bytes. */
  chunk: orgProcedure
    .input(
      id.extend({
        offset: z.number().int().min(0),
        data: z.string().min(1).max(Math.ceil(BUNDLE_CHUNK_BYTES / 3) * 4),
      }),
    )
    .mutation(({ ctx, input }) => appendBundleChunk(ctx, input)),

  finish: abacProcedure(ACTION)
    .input(id)
    .mutation(({ ctx, input }) => finishBundleUpload(ctx, input)),

  status: orgProcedure
    .input(id)
    .query(({ ctx, input }) => bundleUploadStatus(ctx, input)),
});
