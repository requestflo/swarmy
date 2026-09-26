import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import type { DnsGate, DomainDetail } from '@/components/ingress/domain-state';
import type { MapEdge } from './resolver-map';
import { MapLegend, ResolverList } from './resolver-list';
import { gateOf, gateRuleTech, splitResolvers } from './resolver-words';

const ResolverMap = React.lazy(() => import('./resolver-map'));

/** The rule, in one plain sentence (Summary). */
function ruleSentence(g: DnsGate | null): string {
  if (g?.basis === 'local') {
    return 'No public resolver answered, so swarmy is using its own: each one that answers has to point here.';
  }
  const anchors = g?.anchors ?? ['1.1.1.1', '8.8.8.8'];
  const who =
    anchors.length === 2 ? ', including Cloudflare’s and Google’s,' : anchors[0] === '1.1.1.1' ? ', including Cloudflare’s,' : anchors[0] ? ', including Google’s,' : '';
  return `swarmy goes live once most resolvers${who} point here. The rest are old answers that will expire.`;
}

/**
 * "What the world sees" (board 29): the public resolvers swarmy asked on the
 * last check on a world map at each operator's home city, the legend, and the
 * list of what each answered. The same results decide the go-live gate
 * (`dnsGate` in @swarmy/ingress), so the count here is the gate's count.
 */
export function WorldSees({ d, edges }: { d: DomainDetail; edges: MapEdge[] }): React.JSX.Element {
  const { world, local } = splitResolvers(d.dns?.resolvers ?? []);
  const g = gateOf(d);
  const count = g && g.basis === 'public' ? `${g.agreeing} of ${world.length} see your edges` : undefined;
  const mapLabel = `World map: ${world.map((r) => `${r.name} (${r.city ?? 'unknown'}) ${r.state.replace('_', ' ')}`).join('; ')}`;
  return (
    <Section title="What the world sees" count={count}>
      {world.length === 0 && local.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">
          {d.lastCheckedAt ? 'The last check didn’t keep per-resolver answers. Check again to see them.' : 'Not checked yet. The first check runs within a minute.'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {world.length ? (
            <>
              <div className="border-border overflow-hidden rounded-md border">
                <React.Suspense fallback={<div className="bg-muted aspect-[960/372] w-full animate-pulse" />}>
                  <ResolverMap resolvers={world} edges={edges} label={mapLabel} />
                </React.Suspense>
              </div>
              <MapLegend edges={edges.map((e) => e.name)} />
            </>
          ) : null}
          <p className="text-[13.5px] leading-relaxed">{ruleSentence(g)}</p>
          {world.length ? (
            <p className="text-muted-foreground text-[12px] leading-relaxed">
              Each dot sits at the operator’s home city. These resolvers are anycast, so the answer came from whichever of their sites is nearest swarmy, not from the dot.
            </p>
          ) : null}
          <Tech>{gateRuleTech(g)}</Tech>
          <Tech>SWARMY_DOH_RESOLVERS · unset = these {world.length || 12} · off = none (swarmy’s own resolvers decide) · wire:https://… adds an RFC 8484 endpoint</Tech>
          {world.length ? <ResolverList resolvers={world} label="Public resolvers" /> : null}
          {local.length ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-muted-foreground pt-1 font-mono text-[11px] tracking-wider uppercase">Inside your cluster</h3>
              <ResolverList resolvers={local} label="swarmy’s own resolvers" />
              <p className="text-muted-foreground text-[12px]">
                {g?.basis === 'local' ? 'These decide while no public resolver answers.' : 'Shown for reference; they decide only when no public resolver answers.'}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}
