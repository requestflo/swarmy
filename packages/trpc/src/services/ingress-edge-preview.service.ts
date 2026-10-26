/**
 * The Caddyfile each edge runs (board 13). In region-aware rendering every
 * edge gets its own file: a route with copies in several regions lists the
 * receiving edge's region first (`localRegion`, geo-edge-routing invariant 8),
 * so london-1 and new-york-1 run different files. This renders each one on
 * the controller with the same renderer the apply uses, for the same targets
 * (`edgeRenderTargets`: the nodes running the edge task), and seals it with
 * `redactRenderedSecrets` exactly as `ingress.previewConfig` does: members read
 * it, so no tunnel token, bcrypt hash or owner-only file leaves the controller.
 *
 * With no region copies every edge's Caddyfile is byte-identical to the plain
 * render (golden-tested in caddyfile.test.ts); `regional` says which case it is.
 */
import type { RenderedConfig } from '@swarmy/core/protocol';
import { previewConfig as renderIngress, redactRenderedSecrets, type IngressConfig } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { edgeRenderTargets, loadOrgConfig } from './ingress.service';

export interface EdgeConfigView {
  nodeId: string;
  /** The server's name (the node row, else its hostname). */
  name: string;
  /** Its `swarmy.region` label; null when it has none. */
  region: string | null;
  /** That edge's render, sealed for people. */
  rendered: RenderedConfig;
}

export interface EdgeConfigsView {
  /** A route has copies in more than one region, so the files differ by region. */
  regional: boolean;
  /** Sorted by name. Empty when the org's front door is not swarmy's Caddy. */
  edges: EdgeConfigView[];
}

export interface EdgePreviewDeps {
  loadConfig: (ctx: OrgContext) => Promise<IngressConfig>;
  targets: (ctx: OrgContext, config: IngressConfig) => Promise<Array<{ nodeId: string; region?: string }>>;
}

const DEFAULT_DEPS: EdgePreviewDeps = { loadConfig: (ctx) => loadOrgConfig(ctx), targets: edgeRenderTargets };

export async function previewEdgeConfigs(ctx: OrgContext, deps: EdgePreviewDeps = DEFAULT_DEPS): Promise<EdgeConfigsView> {
  const config = await deps.loadConfig(ctx);
  if (config.driver !== 'caddy') return { regional: false, edges: [] };
  const targets = await deps.targets(ctx, config);
  const rows = targets.length
    ? await ctx.db.node.findMany({
        where: { orgId: ctx.activeOrgId, id: { in: targets.map((t) => t.nodeId) } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(rows.map((r) => [r.id, r.name] as const));
  const edges = targets.map((t) => ({
    nodeId: t.nodeId,
    name: names.get(t.nodeId) ?? ctx.hub.nodeInfoFor(t.nodeId)?.hostname ?? t.nodeId,
    region: t.region ?? null,
    // The driver's per-node render: the same config, this node's region first.
    rendered: redactRenderedSecrets(renderIngress({ ...config, enabled: true, localRegion: t.region })),
  }));
  return {
    regional: config.domains.some((d) => (d.regionUpstreams?.length ?? 0) > 0),
    edges: edges.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
