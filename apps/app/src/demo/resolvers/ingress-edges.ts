import type { RenderedConfig } from '@swarmy/core/protocol';
import type { DomainResolvers } from '../types';
import { demoEdgeRender, edgesOf } from './ingress';

/** Mirror of `EdgeConfigsView` (ingress-edge-preview.service.ts). */
interface EdgeConfigsView {
  regional: boolean;
  edges: Array<{ nodeId: string; name: string; region: string | null; rendered: RenderedConfig }>;
}

/**
 * `ingress.edgeConfigs` (board 13): the Caddyfile each demo edge runs. The
 * demo's api.northwind.dev has a copy in eu-west and one in us-east, so the
 * Europe and US edges list them in opposite orders and the diff shows it.
 */
export const ingressEdges: DomainResolvers = {
  handlers: {
    'ingress.edgeConfigs': (_i, s): EdgeConfigsView => {
      const edges = edgesOf(s).flatMap((e) => {
        const rendered = demoEdgeRender(s, e.region ?? undefined);
        return rendered ? [{ nodeId: e.nodeId, name: e.name, region: e.region, rendered }] : [];
      });
      const domains = ((s.extra.ingress as { domains?: Array<{ regions?: string[] }> } | undefined)?.domains ?? []);
      return {
        regional: edges.length > 0 && domains.some((d) => (d.regions?.length ?? 0) > 0),
        edges: edges.sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  },
};
