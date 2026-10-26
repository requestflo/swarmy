import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { Box } from '@/components/networking/curve-labels';
import { estateLabel } from '@/components/networking/mesh-link-words';
import type { PlacedCard } from './map-layout';
import { placeEstateLinkLabels, type EstateMeshLink } from './mesh-link-place';

/**
 * The Mesh lens's link words (board 22): "direct · 11 ms", "relayed · 19 ms"
 * on each reported link, wherever it runs clear of the cards. Screen readers
 * get every pair by name.
 */
export function MeshLinkLabels({
  links,
  cards,
  width,
  keepClear,
  nameOf,
}: {
  links: EstateMeshLink[];
  cards: Map<string, PlacedCard>;
  width: number;
  keepClear: Box[];
  nameOf: (id: string) => string;
}): React.JSX.Element {
  const placed = React.useMemo(() => placeEstateLinkLabels(links, cards, { width, keepClear }), [links, cards, width, keepClear]);
  return (
    <>
      {placed.map((l) => {
        const [path, ...rest] = l.text.split(' · ');
        return (
          <p
            key={l.id}
            aria-hidden
            className="bg-card/85 absolute rounded text-center font-mono text-[12px] leading-5 whitespace-nowrap"
            style={{ left: l.x, top: l.y, width: l.w, height: l.h }}
          >
            <span className={cn(l.relayed ? 'text-tone-warn' : 'text-tone-mesh')}>{rest.length ? `${path} · ` : path}</span>
            {rest.length ? <span className="text-foreground font-semibold">{rest.join(' · ')}</span> : null}
          </p>
        );
      })}
      <span className="sr-only">
        {links
          .flatMap((l) => (l.facts ? [`${nameOf(l.a)} and ${nameOf(l.b)}: ${estateLabel(l.facts) ?? 'no round trip reported'}.`] : []))
          .join(' ')}
      </span>
    </>
  );
}
