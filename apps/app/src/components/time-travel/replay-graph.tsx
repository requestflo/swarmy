import * as React from 'react';
import { FlowSvg } from '@/components/flow/flow-svg';
import { useFlowPaths, type FlowLink } from '@/components/flow/use-flow-paths';
import { useMedia } from '@/components/estate-map/use-media';
import { Tech } from '@/components/calm';
import { clockLabel } from './time-travel-model';
import { rateWords, replayColumns, type ReplayCall } from './replay-graph-model';
import { PartCard } from './replay-part-card';
import type { ReplayPart } from './time-travel-replay';
import { CALLS_WINDOW_MIN } from './use-replay-calls';

interface ReplayGraphProps {
  parts: ReplayPart[];
  live: boolean;
  calls: ReplayCall[];
  /** The calls' window end (ms). */
  until: number;
}

/**
 * The parts as a graph: columns by call depth, a line for each call the
 * traces saw in the minutes before T. On a narrow screen the lines become a
 * list under the cards.
 */
export function ReplayGraph({ parts, live, calls, until }: ReplayGraphProps): React.JSX.Element {
  const wide = useMedia('(min-width: 1024px)');
  const links: FlowLink[] = React.useMemo(() => calls.map((c) => ({ from: c.from, to: c.to, tone: 'base' as const })), [calls]);
  const flow = useFlowPaths(wide ? links : []);
  const byName = new Map(parts.map((p) => [p.name, p]));
  const cols = replayColumns(parts.map((p) => p.name), calls);
  const when = live ? `in the last ${CALLS_WINDOW_MIN} minutes` : `in the ${CALLS_WINDOW_MIN} minutes before ${clockLabel(until)}`;

  return (
    <div className="flex flex-col gap-2">
      {wide ? (
        <div ref={flow.ref} className="relative flex items-center gap-8">
          <FlowSvg paths={flow.paths} size={flow.size} />
          {cols.map((col, i) => (
            <ul key={i} className="flex max-w-60 min-w-0 flex-1 basis-0 flex-col gap-2.5">
              {col.map((name) => (
                <PartCard key={name} p={byName.get(name)!} live={live} />
              ))}
            </ul>
          ))}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {parts.map((p) => (
            <PartCard key={p.name} p={p} live={live} />
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-[12.5px]">
        Lines are calls the traces saw {when}
        {wide ? '' : `: ${calls.map((c) => `${c.from} → ${c.to}`).join(', ')}`}.
      </p>
      <Tech>
        observability.map · until {live ? 'now' : new Date(until).toISOString()} · {calls.map((c) => `${c.from}→${c.to} ${rateWords(c.callsPerMin)}`).join(' · ')}
      </Tech>
    </div>
  );
}
