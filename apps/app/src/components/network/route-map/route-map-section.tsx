import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Section, SectionLink } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import type { HubDomain } from '../use-network';
import { RouteMapCanvas } from './route-map-canvas';
import { litPath, shortService } from './route-map-model';
import { useRouteMap } from './use-route-map';

/**
 * Board 13's routing picture: visitor → DNS → each edge → the app it opens.
 * Pick an address to light its path (the same pick drives the Caddyfile at Code).
 */
export function RouteMapSection({
  domains,
  selected,
  onSelect,
  geo,
  dnsServers,
}: {
  domains: HubDomain[];
  selected: string | null;
  onSelect: (host: string | null) => void;
  geo: boolean;
  dnsServers: number;
}): React.JSX.Element {
  const r = useRouteMap(domains);
  const pick = domains.find((d) => d.host === selected) ?? null;
  const lit = r.map ? litPath(r.map, pick) : null;
  const healthy = r.map?.edges.filter((e) => e.healthy).length;
  return (
    <Section
      title="How a visit reaches your apps"
      count={healthy === undefined ? undefined : `${healthy} edge${healthy === 1 ? '' : 's'} healthy`}
      action={
        <Link to="/ingress">
          <SectionLink>Front door →</SectionLink>
        </Link>
      }
    >
      {r.map ? (
        <RouteMapCanvas map={r.map} lit={lit} geo={geo} dnsServers={dnsServers} />
      ) : r.error ? (
        <ErrorState error={r.error} retry={r.retry} />
      ) : (
        <CardSkeleton lines={3} className="border-0 p-0" />
      )}
      {domains.length > 0 ? (
        <div className="flex flex-col gap-2 pt-1">
          <div role="group" aria-label="Light up an address" className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground mr-1 text-[12.5px]">Light up</span>
            {domains.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={d.host === selected}
                onClick={() => onSelect(d.host === selected ? null : d.host)}
                className={cn(
                  'h-7 rounded-full border px-2.5 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                  d.host === selected ? 'border-primary/70 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {d.host}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-[13px]" aria-live="polite">
            {!pick || !lit
              ? 'Pick an address to light up the way a visit takes.'
              : lit.served
                ? `${pick.host} opens ${pick.stack} / ${shortService(pick.stack, pick.serviceName)}. Any of your ${lit.edges.size} healthy edge${lit.edges.size === 1 ? '' : 's'} can take the visit.`
                : `${pick.host} isn't on your edges yet: ${pick.serving ? 'it waits for its address record' : 'the front door is off'}.`}
          </p>
        </div>
      ) : null}
    </Section>
  );
}
