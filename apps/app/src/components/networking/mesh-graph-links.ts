/** The mesh map's links and the words on them, pure (the second half of `layoutMeshGraph`). */
import { bow, placeLabels, quadPath, type Box, type LabelAsk, type Pt } from './curve-labels';
import { linkPath, mapLabel, pairKey, type MeshLinkLike } from './mesh-link-words';
import type { GraphNode, LinkKind, MeshGraph, PeerState } from './mesh-graph-model';

/** Servers drawn with links: connected, however they link. */
export const ON_MAP = new Set<PeerState>(['direct', 'unknown', 'relayed']);

/** A reported relayed link between two connected servers (the relay then needs a place). */
export function anyRelayedLink(facts: ReadonlyMap<string, MeshLinkLike>, on: ReadonlySet<string>): boolean {
  return [...facts.values()].some((l) => on.has(l.a) && on.has(l.b) && linkPath(l) === 'relayed');
}

/**
 * Every pair of connected servers gets a link: its path is what its ends
 * reported, else the servers' own flags (a relayed server's links all go
 * through the relay). Relayed links run through the relay, the rest bow
 * directly between the pair; a joining server reaches for the nearest
 * connected one. Reported latency becomes words placed clear of the servers.
 */
export function drawLinks(
  nodes: readonly GraphNode[],
  relay: Pt | null,
  facts: ReadonlyMap<string, MeshLinkLike>,
  width: number,
): Pick<MeshGraph, 'links' | 'labels'> {
  const on = nodes.filter((n) => ON_MAP.has(n.state));
  const pairs = on.flatMap((a, i) =>
    on.slice(i + 1).map((b) => {
      const f = facts.get(pairKey(a.id, b.id));
      const flag: LinkKind =
        a.state === 'relayed' || b.state === 'relayed' ? 'relayed' : a.state === 'unknown' || b.state === 'unknown' ? 'unknown' : 'direct';
      return { a, b, f, kind: (f ? linkPath(f) : null) ?? flag };
    }),
  );
  // A relayed link's words sit on its quieter end's segment, so one server's relayed links fan out.
  const degree = new Map<string, number>();
  for (const p of pairs) if (p.kind === 'relayed') for (const n of [p.a, p.b]) degree.set(n.id, (degree.get(n.id) ?? 0) + 1);

  const links: MeshGraph['links'] = [];
  const add = (id: string, kind: LinkKind, d: string): void => {
    if (!links.some((l) => l.id === id)) links.push({ id, kind, d });
  };
  const asks: LabelAsk[] = [];
  const relayedIds = new Set<string>();
  for (const p of pairs) {
    const text = p.f ? mapLabel(p.f) : null;
    const id = pairKey(p.a.id, p.b.id);
    if (p.kind === 'relayed' && relay) {
      add(`relay~${p.a.id}`, 'relayed', quadPath(bow(relay, p.a)));
      add(`relay~${p.b.id}`, 'relayed', quadPath(bow(relay, p.b)));
      const quiet = (degree.get(p.a.id) ?? 0) <= (degree.get(p.b.id) ?? 0) ? p.a : p.b;
      relayedIds.add(id);
      if (text) asks.push({ id, text, curve: bow(relay, quiet) });
    } else {
      const q = bow(p.a, p.b);
      add(`${p.a.id}~${p.b.id}`, p.kind, quadPath(q));
      if (text) asks.push({ id, text, curve: q });
    }
  }
  for (const j of nodes.filter((n) => n.state === 'joining')) {
    const near = on.reduce<GraphNode | null>(
      (best, c) => (!best || Math.hypot(c.x - j.x, c.y - j.y) < Math.hypot(best.x - j.x, best.y - j.y) ? c : best),
      null,
    );
    if (near) links.push({ id: `${j.id}~join`, kind: 'joining', d: quadPath(bow(near, j)) });
  }

  const blockers: Box[] = nodes.map((n) => ({ x: n.x - 44, y: n.y - 28, w: 88, h: 98 }));
  if (relay) blockers.push({ x: relay.x - 72, y: relay.y - 22, w: 144, h: 80 });
  const labels = placeLabels(asks, blockers, { charW: 6.3, h: 16, width }).map((l) => ({ ...l, relayed: relayedIds.has(l.id) }));
  return { links, labels };
}
