/**
 * Image GC executor (epic: git-cicd-registry, PHASE-2).
 *
 * The policy DECISION lives here (controller-side — the only place that knows
 * org-wide "what's deployed where"); the ACTIONS are dispatched as `image.prune`
 * commands to nodes. The cardinal guarantee — never reclaim a digest currently
 * running in prod — is enforced by `computeGcPlan` (pure, unit-tested) over a
 * pinned set computed here from services + successful deployments + live state.
 *
 * Invoked per-org by the `image-gc` worker (apps/api/workers/image-gc.ts) and
 * on-demand. Each org runs under a SYSTEM `OrgContext`.
 */
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import {
  bareDigest,
  computeGcPlan,
  systemContext,
  type GcCandidate,
} from './cicd.service';

export interface GcRunResult {
  orgId: string;
  planned: number;
  pinned: number;
  dispatchedNodes: number;
  reclaimedBytes: number;
  dryRun: boolean;
}

/**
 * Compute the pinned digest set for an org: every digest a prod service can pull.
 *  - each `Service.image` (when digest-pinned, `repo@sha256:…`);
 *  - the `imageDigest` of every COMPLETE deployment (the running history);
 *  - the image of every SUCCEEDED build a service currently points at.
 * A digest that appears here is never collected.
 */
export async function computePinnedDigests(db: DB, orgId: string): Promise<Set<string>> {
  const pinned = new Set<string>();

  const services = await db.service.findMany({
    where: { orgId },
    select: { image: true },
  });
  for (const s of services) {
    if (s.image?.includes('@sha256:')) pinned.add(bareDigest(s.image));
  }

  const deployments = await db.deployment.findMany({
    where: { orgId, phase: 'COMPLETE', imageDigest: { not: null } },
    select: { imageDigest: true },
    orderBy: { startedAt: 'desc' },
    take: 500,
  });
  for (const d of deployments) {
    if (d.imageDigest) pinned.add(bareDigest(d.imageDigest));
  }

  return pinned;
}

/** Run GC for one org. Returns a summary (counts, reclaimed bytes). */
export async function runImageGcForOrg(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  orgId: string,
  opts: { dryRun?: boolean } = {},
): Promise<GcRunResult> {
  const { db, hub } = deps;
  const policy = await db.imageGcPolicy.findUnique({ where: { orgId } });
  // No policy row, or age-days with no window → nothing to do.
  if (!policy) return empty(orgId, opts.dryRun ?? false);

  const mode: 'on-healthcheck' | 'age-days' = policy.mode === 'AGE_DAYS' ? 'age-days' : 'on-healthcheck';
  if (mode === 'age-days' && !policy.days) return empty(orgId, opts.dryRun ?? false);

  const builds = await db.build.findMany({
    where: { orgId, status: 'SUCCEEDED', image: { not: null } },
    select: { id: true, image: true, finishedAt: true },
    orderBy: { finishedAt: 'desc' },
    take: 1000,
  });
  const candidates: GcCandidate[] = builds.map((b) => ({
    buildId: b.id,
    digest: b.image && b.image.includes('@sha256:') ? bareDigest(b.image) : null,
    finishedAt: b.finishedAt,
  }));

  const pinnedDigests = await computePinnedDigests(db, orgId);
  const plan = computeGcPlan({
    mode,
    days: policy.days,
    keepProd: policy.keepProd,
    pinnedDigests,
    candidates,
    now: new Date(),
  });

  if (plan.remove.length === 0) {
    return { orgId, planned: 0, pinned: plan.pinned.length, dispatchedNodes: 0, reclaimedBytes: 0, dryRun: opts.dryRun ?? false };
  }

  // Dispatch a prune to every online node in the org. The keep set is the pinned
  // digests (defence-in-depth: the agent ALSO refuses to delete a pinned digest).
  const reg = await db.registryConfig.findUnique({ where: { orgId }, select: { host: true } });
  const repoPrefix = reg?.host ? `${reg.host}/` : undefined;
  const nodes = await db.node.findMany({ where: { orgId }, select: { id: true } });

  let dispatchedNodes = 0;
  let reclaimedBytes = 0;
  for (const node of nodes) {
    if (!hub.isOnline(node.id)) continue;
    const result = await hub
      .dispatch<{ reclaimedBytes?: number }>(
        node.id,
        'image.prune',
        {
          keepDigests: plan.pinned,
          repoPrefix,
          strategy: mode === 'age-days' ? 'until' : 'all-except-keep',
          untilDays: policy.days ?? undefined,
          dryRun: opts.dryRun ?? false,
        },
        { timeoutMs: 120_000 },
      )
      .catch(() => null);
    if (result) {
      dispatchedNodes++;
      reclaimedBytes += result.reclaimedBytes ?? 0;
    }
  }

  return {
    orgId,
    planned: plan.remove.length,
    pinned: plan.pinned.length,
    dispatchedNodes,
    reclaimedBytes,
    dryRun: opts.dryRun ?? false,
  };
}

/** Run GC across every org that has a policy. Used by the worker tick. */
export async function runImageGcAllOrgs(deps: { db: DB; hub: AgentHub; auth: Auth }): Promise<GcRunResult[]> {
  const policies = await deps.db.imageGcPolicy.findMany({ select: { orgId: true } });
  const out: GcRunResult[] = [];
  for (const p of policies) {
    out.push(await runImageGcForOrg(deps, p.orgId).catch(() => empty(p.orgId, false)));
  }
  return out;
}

function empty(orgId: string, dryRun: boolean): GcRunResult {
  return { orgId, planned: 0, pinned: 0, dispatchedNodes: 0, reclaimedBytes: 0, dryRun };
}

// systemContext is re-exported for the worker's on-demand path.
export { systemContext };
