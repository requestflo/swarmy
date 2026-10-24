/**
 * GC candidates: swarmy's successful builds (queryable HISTORY — which build
 * made which digest), each tagged with the registry repository it was pushed
 * to so `computeGcPlan` can group "keep the last N per repo". Never a source
 * of "what's running": the pinned set always comes from live Docker state.
 */
import type { DB } from '@swarmy/db';
import { bareDigest, type GcCandidate } from './cicd.service';

/** How many recent builds GC reasons over (older ones are simply not candidates). */
export const GC_CANDIDATE_LIMIT = 1000;

/**
 * Registry repository of an image ref: `localhost:5000/team/app@sha256:…` →
 * `team/app`. The first path segment is a host when it has a `.`/`:` or is
 * `localhost` (Docker's rule). Null when the ref has no repository path.
 */
export function repoOfImage(ref: string): string | null {
  const noDigest = ref.split('@')[0] ?? '';
  const parts = noDigest.split('/');
  const first = parts[0] ?? '';
  const hasHost = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const path = (hasHost ? parts.slice(1) : parts).join('/');
  const colon = path.lastIndexOf(':');
  const repo = colon > path.lastIndexOf('/') ? path.slice(0, colon) : path;
  return repo || null;
}

export async function loadGcCandidates(db: DB, orgId: string): Promise<GcCandidate[]> {
  const builds = await db.build.findMany({
    where: { orgId, status: 'SUCCEEDED', image: { not: null } },
    select: { id: true, image: true, finishedAt: true },
    orderBy: { finishedAt: 'desc' },
    take: GC_CANDIDATE_LIMIT,
  });
  return builds.map((b) => ({
    buildId: b.id,
    digest: b.image && b.image.includes('@sha256:') ? bareDigest(b.image) : null,
    finishedAt: b.finishedAt,
    ...(b.image && repoOfImage(b.image) ? { repo: repoOfImage(b.image) as string } : {}),
  }));
}
