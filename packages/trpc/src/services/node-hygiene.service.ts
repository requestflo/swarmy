/**
 * Node disk hygiene — controller side (launch-blocker #8: nodes must never
 * fill up). The DECISION of what must never be removed lives here (only the
 * controller knows org-wide what runs where); the node applies it via the
 * `node.hygiene` agent command (see `@swarmy/core/protocol` hygiene.ts).
 *
 * Keep set (defence in depth with the agent, which ALSO never removes an image
 * any container references — incl. swarm task history = the previous release
 * on that node):
 *   - every digest a live service can pull (`computePinnedDigests`, the image
 *     GC invariant — never delete an in-prod digest);
 *   - every live service's image ref (tag-deployed and scaled-to-zero
 *     services have no running container to pin them);
 *   - the two most recent successful builds per repo (current + previous
 *     release of git-deployed apps, for a fast rollback).
 *
 * Configuration is Docker-native: node labels, editable in the node's label
 * editor — `swarmy.hygiene.enabled=false` opts a node out,
 * `swarmy.hygiene.imageAgeDays` (default 7) and `swarmy.hygiene.buildCacheGb`
 * (default 5) tune it. Each run is logged on the node's activity as an audit
 * `node.hygiene` row carrying what it reclaimed.
 */
import { buildInventory, type NodeHygieneRunView } from '@swarmy/core';
import { HYGIENE_DEFAULTS, type NodeHygieneResult } from '@swarmy/core/protocol';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import type { AgentHub } from '../hub/types';
import { writeAudit } from './audit.service';
import { systemContext } from './cicd.service';
import { computePinnedDigests } from './image-gc.service';

export const HYGIENE_LABELS = {
  enabled: 'swarmy.hygiene.enabled',
  imageAgeDays: 'swarmy.hygiene.imageAgeDays',
  buildCacheGb: 'swarmy.hygiene.buildCacheGb',
} as const;

export interface HygieneSettings {
  enabled: boolean;
  imageMinAgeDays: number;
  buildCacheKeepBytes: number;
}

/** Node labels → effective settings (bad values fall back to the defaults). Pure. */
export function hygieneSettingsFromLabels(labels: Record<string, string> | undefined): HygieneSettings {
  const l = labels ?? {};
  const days = Number.parseInt(l[HYGIENE_LABELS.imageAgeDays] ?? '', 10);
  const gb = Number(l[HYGIENE_LABELS.buildCacheGb] ?? '');
  return {
    enabled: (l[HYGIENE_LABELS.enabled] ?? 'true').toLowerCase() !== 'false',
    imageMinAgeDays: Number.isInteger(days) && days >= 1 && days <= 3650 ? days : HYGIENE_DEFAULTS.imageMinAgeDays,
    buildCacheKeepBytes:
      Number.isFinite(gb) && gb >= 0 && l[HYGIENE_LABELS.buildCacheGb] !== undefined
        ? Math.round(gb * 1024 ** 3)
        : HYGIENE_DEFAULTS.buildCacheKeepBytes,
  };
}

/**
 * The keep set for one org. Pure over its inputs: live service images (from
 * the hub inventory) + the recent successful build images per repo.
 */
export function hygieneKeepSet(input: {
  pinnedDigests: Iterable<string>;
  serviceImages: string[];
  recentBuilds: Array<{ repoId: string; image: string | null }>;
  buildsPerRepo?: number;
}): { keepDigests: string[]; keepRefs: string[] } {
  const digests = new Set<string>(input.pinnedDigests);
  const refs = new Set<string>();
  const addRef = (image: string) => {
    const at = image.indexOf('@');
    if (at >= 0) {
      digests.add(image.slice(at + 1));
      const tagged = image.slice(0, at);
      if (tagged.slice(tagged.lastIndexOf('/') + 1).includes(':')) refs.add(tagged);
    } else if (image) {
      refs.add(image);
    }
  };
  for (const img of input.serviceImages) addRef(img);
  const perRepo = new Map<string, number>();
  const cap = input.buildsPerRepo ?? 2;
  for (const b of input.recentBuilds) {
    if (!b.image) continue;
    const n = perRepo.get(b.repoId) ?? 0;
    if (n >= cap) continue;
    perRepo.set(b.repoId, n + 1);
    addRef(b.image);
  }
  return { keepDigests: [...digests].sort(), keepRefs: [...refs].sort() };
}

async function keepSetForOrg(db: DB, hub: AgentHub, orgId: string) {
  const { services, containers } = hub.liveInventory(orgId);
  const builds = await db.build.findMany({
    where: { orgId, status: 'SUCCEEDED', image: { not: null } },
    select: { repoId: true, image: true },
    orderBy: { finishedAt: 'desc' },
    take: 500,
  });
  return hygieneKeepSet({
    pinnedDigests: computePinnedDigests(hub, orgId),
    serviceImages: buildInventory(services, containers).services.map((s) => s.image),
    recentBuilds: builds,
  });
}

/** Human "2.3 GB" for the activity line. Pure. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The one-line activity summary ("Cleanup reclaimed 2.3 GB — 14 images, …"). Pure. */
export function hygieneSummary(r: NodeHygieneResult): string {
  const parts = [
    `${r.images.removed} image${r.images.removed === 1 ? '' : 's'}`,
    `${r.containers.removed} stopped container${r.containers.removed === 1 ? '' : 's'}`,
    `build cache ${formatBytes(r.buildCache.reclaimedBytes)}`,
  ];
  const verb = r.dryRun ? 'would reclaim' : 'reclaimed';
  return `Cleanup ${verb} ${formatBytes(r.reclaimedBytes)} (${parts.join(', ')})`;
}

export interface HygieneRunOutcome {
  nodeId: string;
  skipped?: 'offline' | 'disabled';
  result?: NodeHygieneResult;
  error?: string;
}

/**
 * Run one hygiene pass on one node (system actor). Skips offline nodes and
 * nodes labelled `swarmy.hygiene.enabled=false`; audits every dispatched run.
 */
export async function runNodeHygieneFor(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  orgId: string,
  nodeId: string,
  opts: { dryRun?: boolean; actor?: OrgContext } = {},
): Promise<HygieneRunOutcome> {
  const { db, hub } = deps;
  if (!hub.isOnline(nodeId)) return { nodeId, skipped: 'offline' };
  const settings = hygieneSettingsFromLabels(hub.nodeInfoFor(nodeId)?.labels);
  if (!settings.enabled && !opts.actor) return { nodeId, skipped: 'disabled' };
  const keep = await keepSetForOrg(db, hub, orgId);
  const ctx = opts.actor ?? systemContext(deps, orgId);
  try {
    const result = await hub.dispatch<NodeHygieneResult>(
      nodeId,
      'node.hygiene',
      {
        ...keep,
        imageMinAgeDays: settings.imageMinAgeDays,
        buildCacheKeepBytes: settings.buildCacheKeepBytes,
        dryRun: opts.dryRun ?? false,
      },
      { timeoutMs: 600_000 },
    );
    await writeAudit(ctx, {
      action: 'node.hygiene',
      ...(opts.actor ? {} : { actorType: 'system' }),
      targetType: 'node',
      targetId: nodeId,
      metadata: {
        summary: hygieneSummary(result),
        reclaimedBytes: result.reclaimedBytes,
        images: result.images.removed,
        containers: result.containers.removed,
        buildCacheBytes: result.buildCache.reclaimedBytes,
        dryRun: result.dryRun,
        errors: result.errors.slice(0, 5),
      },
    });
    return { nodeId, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await writeAudit(ctx, {
      action: 'node.hygiene.failed',
      ...(opts.actor ? {} : { actorType: 'system' }),
      targetType: 'node',
      targetId: nodeId,
      metadata: { error: error.slice(0, 500) },
    }).catch(() => undefined);
    return { nodeId, error };
  }
}

/**
 * Run hygiene on the org's enrolled nodes (optionally only those `include`
 * selects — the worker passes its due set). Used by the worker tick.
 */
export async function runNodeHygieneAllOrgs(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  orgIds: Iterable<string>,
  include: (orgId: string, nodeId: string) => boolean = () => true,
): Promise<HygieneRunOutcome[]> {
  const out: HygieneRunOutcome[] = [];
  for (const orgId of orgIds) {
    try {
      const nodes = await deps.db.node.findMany({ where: { orgId }, select: { id: true } });
      for (const n of nodes) {
        if (!include(orgId, n.id)) continue;
        out.push(await runNodeHygieneFor(deps, orgId, n.id));
      }
    } catch {
      // one org's failure never kills the tick
    }
  }
  return out;
}

// ── tRPC-facing (org-scoped) ──────────────────────────────────────────────────

async function assertNode(ctx: OrgContext, nodeId: string): Promise<void> {
  const node = await ctx.db.node.findFirst({ where: { id: nodeId, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!node) throw notFound('node', nodeId);
}

/** Recent cleanup runs for the node's activity (newest first) + effective settings. */
export async function listNodeHygiene(
  ctx: OrgContext,
  nodeId: string,
): Promise<{ settings: HygieneSettings; runs: NodeHygieneRunView[] }> {
  await assertNode(ctx, nodeId);
  const rows = await ctx.db.auditLog.findMany({
    where: {
      orgId: ctx.activeOrgId,
      targetType: 'node',
      targetId: nodeId,
      action: { in: ['node.hygiene', 'node.hygiene.failed'] },
    },
    orderBy: { ts: 'desc' },
    take: 10,
    select: { action: true, metadata: true, ts: true, actorType: true },
  });
  return {
    settings: hygieneSettingsFromLabels(ctx.hub.nodeInfoFor(nodeId)?.labels),
    runs: rows.map((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0);
      return {
        at: r.ts.toISOString(),
        ok: r.action === 'node.hygiene',
        automatic: r.actorType === 'system',
        summary:
          r.action === 'node.hygiene'
            ? typeof m.summary === 'string'
              ? m.summary
              : `Cleanup reclaimed ${formatBytes(num('reclaimedBytes'))}`
            : `Cleanup failed: ${typeof m.error === 'string' ? m.error : 'unknown error'}`,
        reclaimedBytes: num('reclaimedBytes'),
        dryRun: m.dryRun === true,
      };
    }),
  };
}

/** "Clean up now" from the node page (admin, audited as the user). */
export async function runNodeHygieneNow(
  ctx: OrgContext,
  input: { nodeId: string; dryRun?: boolean },
): Promise<NodeHygieneRunView> {
  await assertNode(ctx, input.nodeId);
  const outcome = await runNodeHygieneFor(
    { db: ctx.db, hub: ctx.hub, auth: ctx.auth },
    ctx.activeOrgId,
    input.nodeId,
    { dryRun: input.dryRun, actor: ctx },
  );
  if (outcome.skipped === 'offline') {
    return { at: new Date().toISOString(), ok: false, automatic: false, summary: 'Node is offline — cleanup not run', reclaimedBytes: 0, dryRun: input.dryRun ?? false };
  }
  if (!outcome.result) {
    return { at: new Date().toISOString(), ok: false, automatic: false, summary: `Cleanup failed: ${outcome.error ?? 'unknown error'}`, reclaimedBytes: 0, dryRun: input.dryRun ?? false };
  }
  return {
    at: new Date().toISOString(),
    ok: true,
    automatic: false,
    summary: hygieneSummary(outcome.result),
    reclaimedBytes: outcome.result.reclaimedBytes,
    dryRun: outcome.result.dryRun,
  };
}
