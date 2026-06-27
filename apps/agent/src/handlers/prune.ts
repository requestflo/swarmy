/**
 * Image prune handler (epic: git-cicd-registry, PHASE-2).
 *
 * Enforces the controller's GC plan on a node: list local images, select the
 * ones to reclaim according to the handed-down `strategy`/`keepDigests`, and
 * `docker rmi` them. The agent is dumb — it never decides what is "in prod";
 * the controller computed `keepDigests` and the agent simply never removes an
 * image whose digest is in that set.
 *
 * Mirrors `buildImage`: consumes a resolved payload, applies it via dockerode,
 * and reports a `commandResult`. Gated by `SWARMY_ALLOW_BUILD` in the executor
 * (the same nodes that build are the ones that accumulate build images).
 */
import type { DockerClient } from '@swarmy/core/docker';
import type {
  PruneImagesPayload,
  PruneImagesResult,
  PrunedImage,
} from '@swarmy/core/protocol';

/** Minimal shape of a dockerode `listImages` entry we depend on (testable). */
export interface RawImage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: number; // unix seconds
  Size?: number;
}

/** The prune plan inputs `selectImagesToPrune` reasons over (test-friendly). */
export interface PrunePlan {
  keepDigests?: string[];
  repoPrefix?: string;
  strategy: 'dangling' | 'until' | 'all-except-keep';
  untilDays?: number;
}

/**
 * Pure selection: split candidate images into {remove, keep} given the plan.
 *
 * Invariants enforced here (the unit-tested core of "never prune in-prod"):
 *  - any image whose digest ∈ keepDigests is ALWAYS kept;
 *  - `repoPrefix`, when set, scopes consideration to swarmy-pushed images only —
 *    everything else (base images, the operator's own images) is kept untouched;
 *  - `dangling` removes only untagged/undigested leftovers;
 *  - `until` removes images created before `nowMs - untilDays` (except keep);
 *  - `all-except-keep` removes everything in scope except the keep set.
 */
export function selectImagesToPrune(
  images: RawImage[],
  plan: PrunePlan,
  nowMs: number = Date.now(),
): { remove: PrunedImage[]; keep: PrunedImage[] } {
  const keepSet = new Set((plan.keepDigests ?? []).filter(Boolean).map(normalizeDigest));
  const remove: PrunedImage[] = [];
  const keep: PrunedImage[] = [];

  for (const img of images) {
    const view = toPrunedImage(img);
    const digests = imageDigests(img).map(normalizeDigest);
    const inScope =
      !plan.repoPrefix ||
      (img.RepoTags ?? []).some((t) => t.startsWith(plan.repoPrefix!)) ||
      (img.RepoDigests ?? []).some((d) => d.startsWith(plan.repoPrefix!));

    // Pinned in prod, or out of scope → always keep.
    if (!inScope || digests.some((d) => keepSet.has(d))) {
      keep.push(view);
      continue;
    }

    const tags = img.RepoTags ?? [];
    const isDangling = tags.length === 0 || tags.every((t) => t.endsWith(':<none>') || t === '<none>:<none>');

    let shouldRemove = false;
    if (plan.strategy === 'dangling') {
      shouldRemove = isDangling;
    } else if (plan.strategy === 'until') {
      const createdMs = (img.Created ?? 0) * 1000;
      const cutoff = nowMs - (plan.untilDays ?? 0) * 24 * 60 * 60 * 1000;
      shouldRemove = createdMs > 0 && createdMs < cutoff;
    } else {
      // all-except-keep
      shouldRemove = true;
    }

    (shouldRemove ? remove : keep).push(view);
  }

  return { remove, keep };
}

/** Extract every digest a `listImages` entry exposes (`sha256:…`). */
export function imageDigests(img: RawImage): string[] {
  const fromRepoDigests = (img.RepoDigests ?? [])
    .map((rd) => rd.split('@')[1])
    .filter((d): d is string => Boolean(d));
  const idDigest = img.Id?.startsWith('sha256:') ? [img.Id] : [];
  return [...new Set([...fromRepoDigests, ...idDigest])];
}

/** Normalize a digest or `repo@sha256:…` ref down to the bare `sha256:…`. */
export function normalizeDigest(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at >= 0 ? ref.slice(at + 1) : ref;
}

function toPrunedImage(img: RawImage): PrunedImage {
  return {
    id: img.Id,
    digest: imageDigests(img)[0] ?? null,
    tags: img.RepoTags ?? [],
    sizeBytes: img.Size ?? 0,
  };
}

export async function pruneImages(
  docker: DockerClient,
  p: PruneImagesPayload,
): Promise<PruneImagesResult> {
  const raw = (await docker.docker.listImages({ all: false })) as unknown as RawImage[];
  const { remove, keep } = selectImagesToPrune(raw, p);

  let reclaimedBytes = 0;
  const removed: PrunedImage[] = [];
  for (const img of remove) {
    if (p.dryRun) {
      reclaimedBytes += img.sizeBytes;
      removed.push(img);
      continue;
    }
    try {
      await docker.docker.getImage(img.id).remove({ force: false });
      reclaimedBytes += img.sizeBytes;
      removed.push(img);
    } catch {
      // image still referenced by a running container / another tag — keep it.
      keep.push(img);
    }
  }

  return { removed, kept: keep, reclaimedBytes, dryRun: p.dryRun };
}
