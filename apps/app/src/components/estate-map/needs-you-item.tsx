import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { AppFixActions } from '@/components/apps/app-fix';
import { sparkPath, trafficValue } from '@/components/apps/app-board-words';
import type { BoardRow } from '@/components/apps/app-board-model';
import { useTRPC } from '@/integrations/trpc';

const W = 300;
const H = 40;

/** Six hours of the app's requests a minute (`traffic.series`); gaps stay gaps. */
function SixHours({ app, tone }: { app: string; tone: 'warn' | 'bad' }): React.JSX.Element {
  const trpc = useTRPC();
  const series = useQuery({ ...trpc.traffic.series.queryOptions({ app, window: '6h' }), refetchInterval: 60_000 });
  if (!series.data) return <TextSkeleton className="h-10 w-full" />;
  const values = series.data.points.map((p) => p.requestsPerMin);
  const known = values.filter((v): v is number => v !== null);
  const d = sparkPath(values, W, H);
  const label = known.length
    ? `${app}, last 6 hours: peak ${trafficValue(Math.max(...known))}, now ${trafficValue(known.at(-1))}`
    : `${app}: no traffic data for the last 6 hours yet`;
  return (
    <figure className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={cn('block h-10 w-full', TONE_TEXT[tone])}>
        <title>{label}</title>
        {d ? <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : null}
      </svg>
      <figcaption className="text-muted-foreground flex justify-between font-mono text-[12px]">
        <span>6 h ago</span>
        <span>{known.length ? `now ${trafficValue(known.at(-1))}` : 'no traffic data yet'}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The one thing that needs you, in the Right-now card: the app's health in a
 * sentence, what changed, six hours of its traffic, and the same put-back and
 * Open incident the Apps list offers (the put-back is the page's one coral).
 */
export function NeedsYouItem({ row }: { row: BoardRow }): React.JSX.Element | null {
  if (!row.fix) return null;
  const tone = row.app.words.tone === 'bad' ? 'bad' : 'warn';
  return (
    <section aria-label={`${row.app.name} needs you`} className="bg-foreground/[0.03] border-border flex flex-col gap-2.5 rounded-xl border p-3.5">
      <p className="text-foreground flex items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
        <span>
          {row.app.name}: <span className={TONE_TEXT[tone]}>{row.app.words.say.replace(/\.$/, '')}</span>
        </span>
      </p>
      <p className="text-muted-foreground text-[13px] leading-snug">{row.fix.diagnosis}</p>
      <SixHours app={row.app.name} tone={tone} />
      <div className="flex flex-wrap items-center gap-2">
        <AppFixActions row={row} primary />
      </div>
    </section>
  );
}
