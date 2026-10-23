import type { NodeSummary } from '@swarmy/core';

export type Topology = 'controller' | 'edge-per-node';

export interface TopoCard {
  title: string;
  sub: string;
  tech: string;
}

export interface TopoEdge extends TopoCard {
  id: string;
  healthy: boolean;
}

export interface TopoView {
  mid: TopoCard;
  edges: TopoEdge[];
  certs: TopoCard & { shared: boolean };
  apps: TopoCard;
  hint: string;
}

export const TOPOLOGY_LABEL: Record<Topology, string> = {
  controller: 'One edge',
  'edge-per-node': 'An edge on every edge server',
};

/**
 * Where the one replicated Caddy lands — the same rule as
 * `ingressPlacementConstraint`: a single pin wins, else any server marked as
 * an edge, else a manager.
 */
export function controllerPlacement(nodes: NodeSummary[], targetNodes: string[]): string {
  if (targetNodes.length === 1) {
    const pin = nodes.find((n) => n.id === targetNodes[0]);
    if (pin) return `on ${pin.name}`;
  }
  return nodes.some((n) => n.ingress) ? 'on one of your edge servers' : 'on a manager';
}

/** Board 31's diagram for one topology, from the servers and the config — nothing invented. */
export function topologyView(input: {
  mode: Topology;
  nodes: NodeSummary[];
  targetNodes: string[];
  geo: boolean;
  apps: string[];
  bucket: string | null;
}): TopoView {
  const perNode = input.mode === 'edge-per-node';
  const edges: TopoEdge[] = perNode
    ? input.nodes
        .filter((n) => n.ingress)
        .map((n) => ({
          id: n.id,
          title: `Caddy · ${n.name}`,
          sub: n.region ?? 'no region set',
          tech: `host-mode :80/:443 · ${n.publicIp ?? 'no public IP'}`,
          healthy: n.status === 'online',
        }))
    : [{ id: 'one', title: 'Caddy', sub: controllerPlacement(input.nodes, input.targetNodes), tech: 'replicated · 1 copy · host-mode :80/:443', healthy: true }];
  const mid: TopoCard = !perNode
    ? { title: 'Your DNS', sub: 'Points at the one server running the edge', tech: 'A record → that server’s IP' }
    : input.geo
      ? { title: 'swarmy-dns', sub: 'Sends each visitor to the nearest healthy edge', tech: 'geo-DNS · answers with edge public IPs' }
      : { title: 'Your DNS', sub: 'Points at every edge; visitors land on any of them', tech: 'A records → every edge IP' };
  const certs = perNode
    ? { title: 'Shared certificates', sub: 'One set for every edge, so none is issued twice', tech: `storage swarmy · replica s3 bucket ${input.bucket ?? 'swarmy-edge-certs'}`, shared: true }
    : { title: 'Certificates', sub: 'Kept on the edge’s own server', tech: 'Caddy data volume', shared: false };
  const apps: TopoCard = {
    title: 'Your apps',
    sub: input.apps.length ? input.apps.join(' · ') : 'No app has an address yet',
    tech: perNode ? 'same region first, other regions as fallback' : 'any copy, over the private network',
  };
  const hint = perNode
    ? input.geo
      ? 'Each edge server runs its own Caddy. swarmy-dns sends visitors to the nearest one, which prefers copies in its own region.'
      : 'Each edge server runs its own Caddy. Turn on Geo-DNS so each visitor reaches the nearest one.'
    : 'One Caddy on one server. Simple, but every visitor goes to that server, so there is no nearest edge.';
  return { mid, edges, certs, apps, hint };
}
