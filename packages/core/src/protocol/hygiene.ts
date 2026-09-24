/**
 * Node disk hygiene (launch-blocker #8: nodes must never fill up).
 *
 * `nodeHygiene` is a controller→agent command dispatched by the `node-hygiene`
 * worker (every 6h per online node) and by `nodes.runHygiene`. The agent, on
 * its LOCAL Docker socket:
 *   1. removes stopped one-shot containers — never a swarm task container
 *      (swarm owns task history, which is also the previous release's image
 *      pin), never one with an always/unless-stopped restart policy (a
 *      deliberately stopped long-lived container), never `swarmy.hygiene.keep`;
 *   2. removes images that no container references (running OR stopped),
 *      whose digest is not in `keepDigests` and no tag in `keepRefs`, that are
 *      dangling or older than `imageMinAgeDays` — the controller-computed keep
 *      set is every live service's image (in-prod digests, scale-to-zero
 *      services) plus the previous successful build per repo, so the GC rule
 *      "never delete an in-prod digest" holds;
 *   3. trims the build cache down to `buildCacheKeepBytes`.
 * It reports what it reclaimed; the controller records it on the node's
 * activity (audit `node.hygiene`).
 *
 * Unlike `pruneImages` (swarmy's own registry images, builder-gated) this is
 * housekeeping every node needs; its gate is the node label
 * `swarmy.hygiene.enabled=false` (controller) plus the local veto
 * `SWARMY_ALLOW_HYGIENE=false` (agent).
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const HYGIENE_DEFAULTS = {
  imageMinAgeDays: 7,
  containerMinAgeHours: 1,
  buildCacheKeepBytes: 5 * 1024 ** 3,
} as const;

export const NodeHygienePayload = z.object({
  ...cmd,
  /** Image digests (`sha256:…`, bare or `repo@sha256:`) that must never be removed. */
  keepDigests: z.array(z.string()).default([]),
  /** Image refs (`repo:tag`) that must never be removed (tag-deployed services). */
  keepRefs: z.array(z.string()).default([]),
  /** Unreferenced tagged images older than this many days are removed. */
  imageMinAgeDays: z.number().int().min(1).max(3650).default(HYGIENE_DEFAULTS.imageMinAgeDays),
  /** Stopped one-shot containers younger than this are left (still inspectable). */
  containerMinAgeHours: z.number().int().min(0).max(8760).default(HYGIENE_DEFAULTS.containerMinAgeHours),
  /** Build cache is trimmed down to this many bytes (0 = remove all of it). */
  buildCacheKeepBytes: z.number().int().min(0).default(HYGIENE_DEFAULTS.buildCacheKeepBytes),
  images: z.boolean().default(true),
  containers: z.boolean().default(true),
  buildCache: z.boolean().default(true),
  /** Plan + report, remove nothing. */
  dryRun: z.boolean().default(false),
});
export type NodeHygienePayload = z.infer<typeof NodeHygienePayload>;

export const NodeHygieneMsg = z.object({
  type: z.literal('nodeHygiene'),
  payload: NodeHygienePayload,
});
export type NodeHygieneMsg = z.infer<typeof NodeHygieneMsg>;

/** Terminal `commandResult.result` for a `nodeHygiene`. */
export interface NodeHygieneResult {
  containers: { removed: number; reclaimedBytes: number };
  images: { removed: number; kept: number; reclaimedBytes: number };
  buildCache: { reclaimedBytes: number };
  /** Sum of the three. */
  reclaimedBytes: number;
  /** Root filesystem usage after the pass, when the agent could read it. */
  disk?: { usedBytes: number; totalBytes: number };
  dryRun: boolean;
  /** Non-fatal step failures (one step failing never aborts the others). */
  errors: string[];
}
