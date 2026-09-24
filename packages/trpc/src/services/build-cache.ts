/**
 * Registry build cache (epic developer-platform §1, competitive gap #13) — PURE.
 *
 * Every build exports its BuildKit cache (`mode=max`) to the in-swarm
 * registry next to the image, and imports it on the next build, so a warm
 * build on a fresh (ephemeral) buildkitd only re-runs the steps whose inputs
 * changed. The registry is inside the swarm network, so pulling cache from it
 * is cheap; a missing ref is just a cold build.
 *
 * Refs: `<host>/<image>:buildcache-<key>-<branch>` — one per build key (context
 * + Dockerfile + target, so monorepo services never clobber each other) per
 * branch. A branch imports its own cache first, then the default branch's, so
 * the first build of a PR branch starts warm.
 *
 * GC: cache refs are cleaned by the existing image-GC tick with an age/size
 * policy (`ImageGcPolicy.cacheMaxAgeDays` / `cacheMaxGb`). The age source is
 * swarmy's own `Build.cacheRef` history (when a build last WROTE the ref); the
 * size comes from the cache manifest itself (read with regctl on a node). A
 * ref written in the last {@link CACHE_GC_GRACE_MS} is never removed (an
 * in-flight build may be importing it). Removing a ref deletes its manifest
 * (tag); cache refs are never image digests anything deploys, so this can't
 * touch a running service.
 */
import { createHash } from 'node:crypto';

export const CACHE_TAG_PREFIX = 'buildcache-';
/** Never remove a cache ref written this recently (in-flight import/export). */
export const CACHE_GC_GRACE_MS = 24 * 3600_000;
export const CACHE_SIZE_MARKER = '@@SWARMY-CACHE-SIZE@@';
export const CACHE_DELETED_MARKER = '@@SWARMY-CACHE-DELETED@@';

/** Tag-safe slug (`[a-z0-9._-]`, ≤ max chars). */
export function tagSlug(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (slug || 'x').slice(0, max).replace(/[-.]+$/, '') || 'x';
}

/**
 * Stable key for a build's inputs: `root` for the default (repo root,
 * `Dockerfile`, no target); otherwise a readable slug of the context plus a
 * short hash of all three.
 */
export function buildCacheKey(input: { subdir?: string; dockerfile?: string; target?: string }): string {
  const subdir = (input.subdir ?? '.').replace(/^\.?\/+|\/+$/g, '') || '.';
  const dockerfile = input.dockerfile ?? 'Dockerfile';
  if (subdir === '.' && dockerfile === 'Dockerfile' && !input.target) return 'root';
  const h = createHash('sha256').update(`${subdir}\n${dockerfile}\n${input.target ?? ''}`).digest('hex').slice(0, 8);
  return `${tagSlug(subdir === '.' ? 'root' : subdir, 24)}-${h}`;
}

/** Export + import refs for one build. */
export function buildCacheRefs(input: {
  host: string;
  imageName: string;
  key: string;
  branch: string;
  defaultBranch: string;
}): { exportRef: string; importRefs: string[] } {
  const ref = (branch: string) =>
    `${input.host}/${input.imageName}:${CACHE_TAG_PREFIX}${input.key}-${tagSlug(branch, 40)}`.slice(0, input.host.length + input.imageName.length + 2 + 128);
  const exportRef = ref(input.branch);
  const fallback = ref(input.defaultBranch);
  return { exportRef, importRefs: fallback === exportRef ? [exportRef] : [exportRef, fallback] };
}

/** Is this image ref a swarmy build-cache ref? */
export function isCacheRef(ref: string): boolean {
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  return !ref.includes('@') && ref.lastIndexOf(':') > ref.lastIndexOf('/') && tag.startsWith(CACHE_TAG_PREFIX);
}

export interface CacheEntry {
  ref: string;
  /** Last time a build wrote (exported) this ref. */
  lastWrittenAt: Date;
  /** Manifest-reported size (sum of blob sizes); null = unknown / missing. */
  sizeBytes: number | null;
}

export interface CacheGcPolicy {
  maxAgeDays: number;
  maxBytes: number;
}

export interface CacheGcPlan {
  remove: Array<{ ref: string; reason: 'age' | 'size' | 'missing' }>;
  keep: string[];
  totalBytes: number;
  keptBytes: number;
}

/**
 * Decide which cache refs to drop: older than `maxAgeDays` first, then the
 * least recently written until the rest fit `maxBytes`. Refs inside the grace
 * window are always kept (and still count toward the budget). A ref whose
 * manifest is gone (`sizeBytes: null`) is reported `missing` — nothing to
 * delete, but the caller can stop tracking it.
 */
export function planCacheGc(entries: readonly CacheEntry[], policy: CacheGcPolicy, now: Date): CacheGcPlan {
  const remove: CacheGcPlan['remove'] = [];
  const keep: string[] = [];
  const ageCutoff = now.getTime() - policy.maxAgeDays * 86_400_000;
  const graceCutoff = now.getTime() - CACHE_GC_GRACE_MS;
  const totalBytes = entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
  const live: CacheEntry[] = [];
  for (const e of entries) {
    const inGrace = e.lastWrittenAt.getTime() >= graceCutoff;
    if (e.sizeBytes === null && !inGrace) remove.push({ ref: e.ref, reason: 'missing' });
    else if (!inGrace && e.lastWrittenAt.getTime() < ageCutoff) remove.push({ ref: e.ref, reason: 'age' });
    else live.push(e);
  }
  // Newest first; keep while within budget (grace refs always kept).
  live.sort((a, b) => b.lastWrittenAt.getTime() - a.lastWrittenAt.getTime());
  let used = 0;
  for (const e of live) {
    const size = e.sizeBytes ?? 0;
    const inGrace = e.lastWrittenAt.getTime() >= graceCutoff;
    if (inGrace || used + size <= policy.maxBytes) {
      used += size;
      keep.push(e.ref);
    } else {
      remove.push({ ref: e.ref, reason: 'size' });
    }
  }
  return { remove, keep, totalBytes, keptBytes: used };
}

/** Single-quote for POSIX sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const regctlPreamble = (registryHost: string): string[] => [
  'set -u',
  `regctl registry set ${sq(registryHost)} --tls disabled >/dev/null 2>&1 || true`,
  `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | regctl registry login ${sq(registryHost)} -u "$SWARMY_REG_USER" --pass-stdin >/dev/null 2>&1 || true; fi`,
];

/**
 * regctl one-shot that prints each ref's cache size (sum of every `size` in
 * its manifest) or `-` when it is gone. Runs in the BOM `regctl` image, host
 * network (`localhost:5000`), creds via env like the system-image mirror.
 */
export function renderCacheSizeScript(refs: readonly string[], registryHost: string): string {
  return [
    ...regctlPreamble(registryHost),
    ...refs.map(
      (r) =>
        `if M=$(regctl manifest get ${sq(r)} --format raw-body 2>/dev/null); then S=$(printf '%s' "$M" | grep -o '"size": *[0-9]*' | sed 's/[^0-9]//g' | awk '{s+=$1} END {print s+0}'); echo "${CACHE_SIZE_MARKER} ${r} $S"; else echo "${CACHE_SIZE_MARKER} ${r} -"; fi`,
    ),
  ].join('\n');
}

export function parseCacheSizes(output: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const line of output.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== CACHE_SIZE_MARKER || !t[1] || t[2] === undefined) continue;
    out.set(t[1], t[2] === '-' ? null : Number.isFinite(Number(t[2])) ? Number(t[2]) : null);
  }
  return out;
}

/** regctl one-shot that deletes each cache ref (tag → manifest). Refuses anything that isn't a cache ref. */
export function renderCacheDeleteScript(refs: readonly string[], registryHost: string): string {
  const safe = refs.filter(isCacheRef);
  return [
    ...regctlPreamble(registryHost),
    ...safe.map((r) => `if regctl tag delete ${sq(r)} >/dev/null 2>&1; then echo "${CACHE_DELETED_MARKER} ${r}"; fi`),
  ].join('\n');
}

export function parseCacheDeleted(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t[0] === CACHE_DELETED_MARKER && t[1])
    .map((t) => t[1] as string);
}
