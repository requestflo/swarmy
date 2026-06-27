/**
 * Image GC protocol (epic: git-cicd-registry, PHASE-2).
 *
 * `pruneImages` is a controller→agent command dispatched by the image-gc worker
 * (and `gc.runNow`). The controller computes the authoritative **keep set** —
 * the digests that must never be reclaimed because they are referenced by a
 * service running in prod — and the agent removes every other matching local
 * image, reporting what it reclaimed.
 *
 * The "keep" list is the controller-computed pinned set; the agent never reasons
 * about what is "in prod" — it only enforces the explicit keep/strategy it is
 * handed (mirrors how `applyMesh`/`buildImage` consume resolved intent).
 *
 * Added to `ControllerToAgentMessage` (messages.ts) and `CommandResultMap`
 * (results.ts); `image.prune` is registered in `COMMAND_PROTOCOL_TYPE`
 * (packages/trpc/src/hub/types.ts). See INTEGRATION.
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

/** Reusable command preamble (every controller→agent command carries these). */
const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const PruneImagesPayload = z.object({
  ...cmd,
  /**
   * Image digests (`sha256:…`) that MUST be kept — the controller-computed pinned
   * set (every digest a prod service can pull). Never reclaimed, regardless of age.
   */
  keepDigests: z.array(z.string()).default([]),
  /**
   * Image reference prefix to scope pruning to (e.g. `swarmy-registry:5000/`), so
   * GC only ever touches images swarmy built/pushed — never the operator's base
   * images. Optional: omitted = consider all images.
   */
  repoPrefix: z.string().optional(),
  strategy: z
    .enum([
      /** Remove only dangling (untagged, unreferenced) images. */
      'dangling',
      /** Remove images created before `untilDays` ago, except the keep set. */
      'until',
      /** Remove every matching image except the keep set. */
      'all-except-keep',
    ])
    .default('all-except-keep'),
  untilDays: z.number().int().positive().optional(),
  /** Compute + report the plan but remove nothing. */
  dryRun: z.boolean().default(false),
});
export type PruneImagesPayload = z.infer<typeof PruneImagesPayload>;

export const PruneImagesMsg = z.object({
  type: z.literal('pruneImages'),
  payload: PruneImagesPayload,
});
export type PruneImagesMsg = z.infer<typeof PruneImagesMsg>;

/** A single image considered for / selected by a prune pass. */
export interface PrunedImage {
  id: string;
  digest: string | null;
  tags: string[];
  sizeBytes: number;
}

/** Terminal `commandResult.result` for a `pruneImages`. Mirrors `CommandResultMap`. */
export interface PruneImagesResult {
  /** Image refs/ids actually removed (or that WOULD be removed when `dryRun`). */
  removed: PrunedImage[];
  /** Image refs/ids retained because their digest was in the keep set. */
  kept: PrunedImage[];
  reclaimedBytes: number;
  dryRun: boolean;
}
