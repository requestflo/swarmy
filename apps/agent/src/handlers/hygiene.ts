/**
 * Node disk hygiene handler (launch-blocker #8: nodes must never fill up).
 *
 * Applies one `nodeHygiene` pass on the LOCAL Docker socket: stopped one-shot
 * containers → unreferenced images → build cache over the cap. The DECISIONS
 * are the pure `selectContainersToRemove` / `selectHygieneImages` below
 * (unit-tested); the controller hands down the keep set (every live service's
 * image digest/ref + the previous successful build per repo), and on top of
 * it this handler never removes an image ANY container still references —
 * running or stopped, which includes swarm's task history (the previous
 * release on this node). One step failing never aborts the others.
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { NodeHygienePayload, NodeHygieneResult } from '@swarmy/core/protocol';
import { imageDigests, normalizeDigest, type RawImage } from './prune';

/** Label that pins a stopped container against hygiene (operator escape hatch). */
export const HYGIENE_KEEP_LABEL = 'swarmy.hygiene.keep';
const SWARM_TASK_LABEL = 'com.docker.swarm.task.id';
const STOPPED_STATES = new Set(['exited', 'dead', 'created']);
const LONG_LIVED_RESTART = new Set(['always', 'unless-stopped']);

/** The `listContainers({all,size})` fields the plan reads (+ inspected restart policy). */
export interface RawContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Created?: number; // unix seconds
  Labels?: Record<string, string> | null;
  SizeRw?: number;
  /** `HostConfig.RestartPolicy.Name` from inspect (listContainers doesn't carry it). */
  restartPolicy?: string;
}

/**
 * Stopped one-shot containers to remove. Kept: running/paused/restarting
 * containers, swarm task containers (swarm owns task history), anything with
 * an always/unless-stopped restart policy (deliberately stopped), anything
 * labelled `swarmy.hygiene.keep=true`, and anything stopped for less than
 * `minAgeHours` (still worth inspecting).
 */
export function selectContainersToRemove(
  containers: RawContainer[],
  minAgeHours: number,
  nowMs: number = Date.now(),
): RawContainer[] {
  const cutoff = nowMs - minAgeHours * 3_600_000;
  return containers.filter((c) => {
    if (!STOPPED_STATES.has(c.State ?? '')) return false;
    const labels = c.Labels ?? {};
    if (labels[SWARM_TASK_LABEL]) return false;
    if (labels[HYGIENE_KEEP_LABEL] === 'true') return false;
    if (c.restartPolicy && LONG_LIVED_RESTART.has(c.restartPolicy)) return false;
    const createdMs = (c.Created ?? 0) * 1000;
    return createdMs > 0 && createdMs < cutoff;
  });
}

/** Tag normalisation so `nginx` / `docker.io/library/nginx:latest` compare equal. */
export function normalizeRef(ref: string): string {
  let r = ref.trim();
  const at = r.indexOf('@');
  if (at >= 0) r = r.slice(0, at);
  const lastSlash = r.lastIndexOf('/');
  if (!r.slice(lastSlash + 1).includes(':')) r = `${r}:latest`;
  if (r.startsWith('docker.io/')) r = r.slice('docker.io/'.length);
  if (r.startsWith('library/')) r = r.slice('library/'.length);
  return r;
}

export interface HygieneImagePlan {
  keepDigests: string[];
  keepRefs: string[];
  /** Image ids any container (running or stopped) references. */
  referencedIds: Set<string>;
  minAgeDays: number;
}

/**
 * Images to remove. An image is KEPT when any of: a container references it;
 * a digest is in `keepDigests` (the in-prod pin — the GC invariant); a tag
 * is in `keepRefs`; or it is tagged and younger than `minAgeDays` (by the
 * later of build time and last pull/tag time, `lastTagMs`). Dangling
 * (untagged) images with no referencing container are always removed.
 */
export function selectHygieneImages(
  images: Array<RawImage & { lastTagMs?: number }>,
  plan: HygieneImagePlan,
  nowMs: number = Date.now(),
): { remove: Array<RawImage & { lastTagMs?: number }>; kept: number } {
  const keepDigests = new Set(plan.keepDigests.filter(Boolean).map(normalizeDigest));
  const keepRefs = new Set(plan.keepRefs.filter(Boolean).map(normalizeRef));
  const cutoff = nowMs - plan.minAgeDays * 86_400_000;
  const remove: Array<RawImage & { lastTagMs?: number }> = [];
  let kept = 0;
  for (const img of images) {
    const tags = (img.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>');
    const pinned =
      plan.referencedIds.has(img.Id) ||
      imageDigests(img).some((d) => keepDigests.has(normalizeDigest(d))) ||
      tags.some((t) => keepRefs.has(normalizeRef(t))) ||
      (img.RepoDigests ?? []).some((rd) => keepRefs.has(normalizeRef(rd)));
    if (pinned) {
      kept++;
      continue;
    }
    if (tags.length === 0) {
      remove.push(img);
      continue;
    }
    const freshMs = Math.max((img.Created ?? 0) * 1000, img.lastTagMs ?? 0);
    if (freshMs > 0 && freshMs < cutoff) remove.push(img);
    else kept++;
  }
  return { remove, kept };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runNodeHygiene(docker: DockerClient, p: NodeHygienePayload): Promise<NodeHygieneResult> {
  const d = docker.docker;
  const result: NodeHygieneResult = {
    containers: { removed: 0, reclaimedBytes: 0 },
    images: { removed: 0, kept: 0, reclaimedBytes: 0 },
    buildCache: { reclaimedBytes: 0 },
    reclaimedBytes: 0,
    dryRun: p.dryRun,
    errors: [],
  };

  // 1. Stopped one-shot containers (first, so their images become unreferenced).
  if (p.containers) {
    try {
      const list = (await d.listContainers({ all: true, size: true })) as unknown as RawContainer[];
      const stopped = list.filter((c) => STOPPED_STATES.has(c.State ?? ''));
      for (const c of stopped) {
        try {
          const info = (await d.getContainer(c.Id).inspect()) as { HostConfig?: { RestartPolicy?: { Name?: string } } };
          c.restartPolicy = info.HostConfig?.RestartPolicy?.Name ?? '';
        } catch {
          c.restartPolicy = 'always'; // can't tell → treat as long-lived (keep)
        }
      }
      for (const c of selectContainersToRemove(stopped, p.containerMinAgeHours)) {
        try {
          // v:true drops the container's ANONYMOUS volumes (e.g. a one-shot
          // BuildKit cache); named volumes are never touched.
          if (!p.dryRun) await d.getContainer(c.Id).remove({ v: true });
          result.containers.removed++;
          result.containers.reclaimedBytes += c.SizeRw ?? 0;
        } catch (e) {
          result.errors.push(`container ${c.Names?.[0] ?? c.Id.slice(0, 12)}: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      result.errors.push(`containers: ${errMsg(e)}`);
    }
  }

  // 2. Unreferenced images.
  if (p.images) {
    try {
      const containers = (await d.listContainers({ all: true })) as unknown as RawContainer[];
      const referencedIds = new Set(containers.map((c) => c.ImageID).filter((x): x is string => Boolean(x)));
      const raw = (await d.listImages({ all: false })) as unknown as Array<RawImage & { lastTagMs?: number }>;
      // Last pull/tag time only matters for tagged candidates past build-age.
      const cutoff = Date.now() - p.imageMinAgeDays * 86_400_000;
      for (const img of raw) {
        if ((img.RepoTags ?? []).length === 0 || (img.Created ?? 0) * 1000 >= cutoff) continue;
        try {
          const info = (await d.getImage(img.Id).inspect()) as { Metadata?: { LastTagTime?: string } };
          const t = Date.parse(info.Metadata?.LastTagTime ?? '');
          if (Number.isFinite(t) && t > 0) img.lastTagMs = t;
        } catch {
          img.lastTagMs = Date.now(); // can't tell → treat as fresh (keep)
        }
      }
      const plan = selectHygieneImages(raw, {
        keepDigests: p.keepDigests,
        keepRefs: p.keepRefs,
        referencedIds,
        minAgeDays: p.imageMinAgeDays,
      });
      result.images.kept = plan.kept;
      for (const img of plan.remove) {
        try {
          // force:false — the engine refuses an image a container still uses.
          if (!p.dryRun) await d.getImage(img.Id).remove({ force: false });
          result.images.removed++;
          result.images.reclaimedBytes += img.Size ?? 0;
        } catch {
          result.images.kept++; // shared layers / another tag / a racing container
        }
      }
    } catch (e) {
      result.errors.push(`images: ${errMsg(e)}`);
    }
  }

  // 3. Build cache over the cap.
  if (p.buildCache && !p.dryRun) {
    try {
      result.buildCache.reclaimedBytes = (await docker.pruneBuildCache(p.buildCacheKeepBytes)).reclaimedBytes;
    } catch (e) {
      result.errors.push(`build cache: ${errMsg(e)}`);
    }
  }

  result.reclaimedBytes =
    result.containers.reclaimedBytes + result.images.reclaimedBytes + result.buildCache.reclaimedBytes;
  return result;
}
