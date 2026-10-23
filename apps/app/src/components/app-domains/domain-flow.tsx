import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';

interface Props {
  stack: string;
  /** The app's visits a minute (all its addresses); null = nothing reported, so no number. */
  visitsPerMin: number | null;
  windowMinutes: number | null;
  rulesOn: number;
  target: string;
}

/**
 * The traffic strip (board 30): visitors → the front door (with how many
 * protections it applies here) → the service. The visit rate is the app's,
 * across all its addresses, and says so.
 */
export function DomainFlow({ stack, visitsPerMin, windowMinutes, rulesOn, target }: Props): React.JSX.Element {
  return (
    <div className="calm-card flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="How a visit reaches the app">
        <Stop title="Visitors" sub={visitsPerMin !== null ? `to ${stack} · ${Math.round(visitsPerMin).toLocaleString('en-GB')} a minute` : `to ${stack}`} />
        <span aria-hidden className="flow-dashes hidden sm:block" />
        <Stop title="Front door" sub={`${rulesOn} protection${rulesOn === 1 ? '' : 's'} on`} accent />
        <span aria-hidden className="flow-dashes hidden sm:block" />
        <Stop title={target} sub="your service" mono />
      </div>
      {visitsPerMin !== null ? <Tech>traffic.now · requests/min for every address of {stack}, last {windowMinutes ?? 5} min at the edge</Tech> : null}
    </div>
  );
}

function Stop({ title, sub, accent, mono }: { title: string; sub: string; accent?: boolean; mono?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-0.5 rounded-[10px] border px-3 py-1.5', accent ? 'border-primary/50' : 'border-border')}>
      <span className={cn('text-[12.5px] font-semibold', mono && 'font-mono')}>{title}</span>
      <span className="text-muted-foreground font-mono text-[11px]">{sub}</span>
    </div>
  );
}
