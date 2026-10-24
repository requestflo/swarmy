/**
 * Registry-side GC plan (PURE, unit-tested in `registry-gc.plan.test.ts`).
 *
 * Node GC (`image.prune`) only frees node disk; this decides which MANIFESTS
 * to delete from the in-swarm `registry:2` so its volume stops growing. Two
 * sources, one invariant — a digest in the LIVE pinned set (every running or
 * scaled-to-zero service, every running container, every retained service on a
 * disconnected manager) is never deleted, whatever the mode, and even when the
 * policy's `keepProd` is off (that hobby opt-out reaches node disk, never the
 * registry a server must pull from):
 *
 *  1. `policy` — swarmy builds `computeGcPlan` selected (keep-last / age-days).
 *     ON_HEALTHCHECK selects every non-running build, so the registry keeps
 *     those as rollback targets: that mode stays node-local for builds.
 *  2. `untagged` — manifests no tag and no index points at (superseded
 *     build-cache manifests, re-pushed tags). Every swarmy build digest is left
 *     to the policy, so an untagged in-prod or kept build is never swept here.
 *
 * Nothing written in the last `graceMs` is touched (an in-flight build/deploy
 * may be about to pull it), nor any build of a repo a live service pulls by
 * TAG (a floating ref — its digest isn't pinned, so the whole repo is held).
 */
import { createHash } from 'node:crypto';
import { bareDigest, type GcCandidate, type GcMode, type GcPlan } from './cicd.service';
import { repoOfImage } from './gc-candidates';

/** Never delete a manifest written / built this recently. */
export const REGISTRY_GC_GRACE_MS = 24 * 3600_000;
/** Deletes per pass (the rest wait for the next tick). */
export const REGISTRY_GC_MAX_DELETES = 300;

export interface UntaggedManifest {
  repo: string;
  digest: string;
  /** When the manifest was pushed (its revision link's mtime). */
  modifiedAt: Date;
}

export interface RegistryDelete {
  repo: string;
  digest: string;
  reason: 'policy' | 'untagged';
}

export interface RegistryGcPlanInput {
  mode: GcMode;
  /** `computeGcPlan` over swarmy's builds (its `remove` is what `policy` may delete). */
  plan: GcPlan;
  candidates: readonly GcCandidate[];
  /** LIVE pinned digests (bare or `repo@sha256:`), always honoured. */
  pinnedDigests: ReadonlySet<string>;
  /** Repos a live service pulls by tag — their builds are never policy-deleted. */
  floatingRepos: ReadonlySet<string>;
  untagged: readonly UntaggedManifest[];
  now: Date;
  graceMs?: number;
  max?: number;
}

export function planRegistryGc(input: RegistryGcPlanInput): RegistryDelete[] {
  const pinned = new Set([...input.pinnedDigests].map(bareDigest));
  const cutoff = input.now.getTime() - (input.graceMs ?? REGISTRY_GC_GRACE_MS);
  const out = new Map<string, RegistryDelete>();
  const add = (repo: string, digest: string, reason: RegistryDelete['reason']) => {
    if (!pinned.has(digest)) out.set(`${repo}@${digest}`, { repo, digest, reason });
  };

  if (input.mode !== 'on-healthcheck') {
    const selected = new Set(input.plan.remove.map(bareDigest));
    for (const c of input.candidates) {
      if (!c.digest || !c.repo || input.floatingRepos.has(c.repo)) continue;
      const d = bareDigest(c.digest);
      const ts = c.finishedAt?.getTime() ?? 0;
      if (selected.has(d) && ts > 0 && ts < cutoff) add(c.repo, d, 'policy');
    }
  }

  const builds = new Set(input.candidates.flatMap((c) => (c.digest ? [bareDigest(c.digest)] : [])));
  for (const u of input.untagged) {
    const d = bareDigest(u.digest);
    const ts = u.modifiedAt.getTime();
    if (builds.has(d) || !(ts > 0 && ts < cutoff)) continue;
    add(u.repo, d, 'untagged');
  }

  return [...out.values()]
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.repo.localeCompare(b.repo) || a.digest.localeCompare(b.digest))
    .slice(0, input.max ?? REGISTRY_GC_MAX_DELETES);
}

/** Deterministic signature of a delete set ('' = nothing to do) — the worker's gate. */
export function registryGcSignature(deletes: readonly RegistryDelete[]): string {
  if (!deletes.length) return '';
  const keys = deletes.map((d) => `${d.repo}@${d.digest}`).sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
}

/** Repos of org-registry images a service pulls by tag (no `@sha256:`). */
export function floatingRepos(images: readonly string[], isOrgImage: (image: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const img of images) {
    if (img.includes('@sha256:') || !isOrgImage(img)) continue;
    const repo = repoOfImage(img);
    if (repo) out.add(repo);
  }
  return out;
}
