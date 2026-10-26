/**
 * The Mesh lens's links on the estate map (board 22), pure: one curve per
 * pair of servers between their card centres, and the reported words on it
 * ("direct · 11 ms", "relayed · 19 ms") wherever the curve runs clear of
 * every card. A link nobody reported gets no words (absent is never a zero).
 */
import { bow, placeLabels, type Box, type PlacedLabel, type Quad } from '@/components/networking/curve-labels';
import { estateLabel, linkPath, type MeshLinkLike } from '@/components/networking/mesh-link-words';
import type { PlacedCard } from './map-layout';

export interface EstateMeshLink {
  a: string;
  b: string;
  /** Both servers connected to the private network. */
  ok: boolean;
  /** What the link's ends reported (`mesh.links`); absent = not reported. */
  facts?: MeshLinkLike;
}

/** The curve between two cards' centres (the same bow the lens draws). */
export function estateCurve(a: PlacedCard, b: PlacedCard): Quad {
  return bow({ x: a.x + a.w / 2, y: a.y + a.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, 80);
}

export const isRelayed = (l: EstateMeshLink): boolean => !!l.facts && linkPath(l.facts) === 'relayed';

/** Words for the reported links, placed clear of the cards (and of `keepClear`); the rest are left off. */
export function placeEstateLinkLabels(
  links: readonly EstateMeshLink[],
  cards: ReadonlyMap<string, PlacedCard>,
  o: { width: number; keepClear?: readonly Box[] },
): (PlacedLabel & { relayed: boolean })[] {
  const asks = links.flatMap((l) => {
    const a = cards.get(l.a);
    const b = cards.get(l.b);
    const text = l.facts ? estateLabel(l.facts) : null;
    return a && b && text ? [{ id: `${l.a}~${l.b}`, text, curve: estateCurve(a, b) }] : [];
  });
  const blockers: Box[] = [...[...cards.values()].map((c) => ({ x: c.x - 6, y: c.y - 6, w: c.w + 12, h: c.h + 12 })), ...(o.keepClear ?? [])];
  const relayed = new Set(links.filter(isRelayed).map((l) => `${l.a}~${l.b}`));
  return placeLabels(asks, blockers, { charW: 7.2, h: 20, width: o.width }).map((p) => ({ ...p, relayed: relayed.has(p.id) }));
}
