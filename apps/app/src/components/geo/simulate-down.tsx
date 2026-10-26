import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { CalmRow, RowList, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { ASK_FROM, type AskEndpoint, type AskFrom } from './ask-model';
import type { DnsZoneView } from './geo-types';
import { simulateWords } from './simulate-model';

const REGIONS = ASK_FROM.map((r) => r.id);

/**
 * "Simulate <edge> down" (board 32): pick a front door and see, for every
 * place a visitor can ask from, who would answer instead and where visitors
 * spill (`geodns.simulateDown` runs the real answering engine with that edge
 * marked down). Read-only: nothing is changed or pushed.
 */
export function SimulateDown({ zone, host, endpoints, from }: { zone: DnsZoneView; host: string | null; endpoints: AskEndpoint[]; from: AskFrom }): React.JSX.Element | null {
  const trpc = useTRPC();
  const [ip, setIp] = React.useState<string | null>(null);
  const sim = useQuery({
    ...trpc.geodns.simulateDown.queryOptions({ id: zone.id, host: host ?? zone.zone, ip: ip ?? '', regions: REGIONS }),
    enabled: !!host && !!ip,
  });
  if (!host || endpoints.length < 2) return null;
  const words = ip && sim.data ? simulateWords(sim.data, endpoints, ASK_FROM) : null;
  return (
    <div className="border-border flex flex-col gap-2.5 border-t pt-3">
      <div role="group" aria-label="Simulate a front door going down" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-semibold">What if one went down?</span>
        {endpoints.map((e) => (
          <Button
            key={e.ip}
            size="sm"
            variant="outline"
            aria-pressed={ip === e.ip}
            onClick={() => setIp(ip === e.ip ? null : e.ip)}
            className="aria-pressed:border-primary aria-pressed:bg-primary/10 pointer-coarse:min-h-11"
          >
            Simulate {e.name} down
          </Button>
        ))}
      </div>
      {!ip ? null : sim.isError ? (
        <p className="text-tone-bad text-[13.5px]">{sim.error.message}</p>
      ) : !words ? (
        <div className="shimmer-line h-24 rounded-md" aria-hidden />
      ) : (
        <>
          <p className="text-[14px] font-semibold">{words.headline}</p>
          <RowList label="Who would answer each region">
            {words.lines.map((l) => (
              <CalmRow
                key={l.from}
                tone={l.tone}
                name={l.label}
                say={l.say}
                tech={l.tech}
                word={l.word}
                className={l.from === from ? 'bg-foreground/[0.03]' : undefined}
              />
            ))}
          </RowList>
          <p className="text-muted-foreground text-[12.5px] leading-relaxed">
            {words.timing} Nothing is changed: this only works out the answers.
          </p>
          <Tech>geodns.simulateDown · the answering engine with {ip} marked down · read-only, nothing pushed</Tech>
        </>
      )}
    </div>
  );
}
