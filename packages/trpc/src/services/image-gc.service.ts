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
import { buildInventory, isBuilderCapable } from '@swarmy/core';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import {
  bareDigest,
  computeGcPlan,
  convergeRegistryAuth,
  systemContext,
  type GcCandidate,
} from './cicd.service';
import { canonicalRegistryHost } from './registryPolicy.service';

export interface GcRunResult {
  orgId: string;
  planned: number;
  pinned: number;
  dispatchedNodes: number;
  reclaimedBytes: number;
  dryRun: boolean;
}

/**
 * Compute the pinned digest set for an org from LIVE Docker state (the source of
 * truth) — every digest a currently-running service can pull:
 *  - each live service's resolved image (Docker pins it to `repo@sha256:…`);
 *  - each running container's image digest (the actually-pulled layers).
 * A digest that appears here is never collected. Reads the in-memory hub
 * inventory rather than any Service/Deployment DB row.
 */
export function computePinnedDigests(hub: AgentHub, orgId: string): Set<string> {
  const pinned = new Set<string>();
  const { services, containers } = hub.liveInventory(orgId);
  for (const s of buildInventory(services, containers).services) {
    if (s.image.includes('@sha256:')) pinned.add(bareDigest(s.image));
    for (const c of s.containers) {
      if (c.image.includes('@sha256:')) pinned.add(bareDigest(c.image));
    }
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

  const pinnedDigests = computePinnedDigests(hub, orgId);
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

  // Dispatch a prune to every online builder-capable node in the org. The keep set is the pinned
  // digests (defence-in-depth: the agent ALSO refuses to delete a pinned digest).
  const reg = await db.registryConfig.findUnique({ where: { orgId }, select: { host: true } });
  // Scope to the canonical push host (a legacy `swarmy-registry:5000` row maps
  // to `localhost:5000`, where builds now push).
  const repoPrefix = reg ? `${canonicalRegistryHost(reg.host)}/` : undefined;
  const nodes = await db.node.findMany({ where: { orgId }, select: { id: true } });

  let dispatchedNodes = 0;
  let reclaimedBytes = 0;
  for (const node of nodes) {
    if (!hub.isOnline(node.id)) continue;
    // Image GC rides the build gate: only builder-capable nodes (the ones that
    // accumulate build images) prune — others would answer E_BUILD_DISABLED.
    if (!isBuilderCapable(hub.nodeInfoFor(node.id)?.labels, hub.agentBuildFor?.(node.id)?.buildOverride)) continue;
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
          builderCapable: true,
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
  // Registry auth converge rides the same tick: an enabled registry that is
  // still open (pre-auth install) or drifted from its stored login is closed.
  try {
    const registries = await deps.db.registryConfig.findMany({ where: { enabled: true }, select: { orgId: true } });
    for (const r of registries) {
      await convergeRegistryAuth(systemContext(deps, r.orgId)).catch(() => undefined);
    }
  } catch {
    // Never let the registry converge break GC.
  }
  // Housekeeping for EVERY node, builder or not: dangling images pile up on
  // any node that redeploys, and a full disk takes the controller DB with it.
  await pruneDanglingEverywhere(deps).catch(() => undefined);
  const policies = await deps.db.imageGcPolicy.findMany({ select: { orgId: true } });
  const out: GcRunResult[] = [];
  for (const p of policies) {
    out.push(await runImageGcForOrg(deps, p.orgId).catch(() => empty(p.orgId, false)));
  }
  return out;
}

/**
 * Prune dangling (untagged, unreferenced) images on every online node. Tagged
 * images, anything a container uses (Docker refuses), and every in-prod pinned
 * digest are kept — this can never remove something a service needs.
 */
export async function pruneDanglingEverywhere(deps: { db: DB; hub: AgentHub }): Promise<number> {
  const nodes = await deps.db.node.findMany({ select: { id: true, orgId: true } });
  let dispatched = 0;
  for (const node of nodes) {
    if (!deps.hub.isOnline(node.id)) continue;
    const pinned = [...computePinnedDigests(deps.hub, node.orgId)];
    const ok = await deps.hub
      .dispatch(
        node.id,
        'image.prune',
        { keepDigests: pinned, strategy: 'dangling', dryRun: false },
        { timeoutMs: 120_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (ok) dispatched++;
  }
  return dispatched;
}

function empty(orgId: string, dryRun: boolean): GcRunResult {
  return { orgId, planned: 0, pinned: 0, dispatchedNodes: 0, reclaimedBytes: 0, dryRun };
}

// systemContext is re-exported for the worker's on-demand path.
export { systemContext };
