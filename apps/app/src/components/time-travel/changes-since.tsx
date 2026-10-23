import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { agoLabel, clockLabel, eventsAt, momentLabel, type TravelEvent } from './time-travel-model';
import type { Change } from './time-travel-replay';

const VERB: Record<Change['status'], string> = {
  deploying: 'rolling out',
  healthy: 'went out',
  superseded: 'went out',
  'rolled-back': 'went out, put back',
  failed: 'failed its check',
};

function changeText(c: Change): string {
  const parts = c.parts.length ? c.parts.join(', ') : 'no image changes';
  const gone = c.removed.length ? ` · removed ${c.removed.join(', ')}` : '';
  return `${parts}${gone} · ${c.putBack ? 'put back' : VERB[c.status]}`;
}

/** The moment the head is on, and what happened right there (the events at T). */
export function ViewingCard({ at, live, now, events }: { at: number; live: boolean; now: number; events: TravelEvent[] }): React.JSX.Element {
  const here = live ? [] : eventsAt(events, at);
  return (
    <section aria-label="Viewing" className="flex flex-col gap-1">
      <span className="calm-eyebrow">Viewing</span>
      <span className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-display text-[1.75rem] font-bold tracking-[-0.02em]">{live ? 'Now' : momentLabel(at)}</span>
        <span className="text-muted-foreground font-mono text-[12px]">{live ? 'live' : agoLabel(at, now)}</span>
      </span>
      {here.map((e) => (
        <span key={e.id} className="text-[13px]">
          {e.title}
        </span>
      ))}
    </section>
  );
}

/** What changed since then: every version that went out after T, newest first. */
export function ChangesSince({ changes, live, now }: { changes: Change[]; live: boolean; now: number }): React.JSX.Element {
  return (
    <Section title="What changed since then" count={changes.length || undefined}>
      {changes.length ? (
        <ul className="flex flex-col gap-2">
          {changes.map((c) => (
            <li key={c.id} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-2.5 text-[13px]">
                <span className={cn('font-mono text-[12px] font-semibold', c.status === 'failed' || c.status === 'rolled-back' ? 'text-tone-warn' : 'text-tone-info')}>{c.label}</span>
                <span className="min-w-0 flex-1 truncate">{changeText(c)}</span>
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{now - c.at < 864e5 ? clockLabel(c.at) : momentLabel(c.at)}</span>
              </span>
              <Tech className="truncate">release {c.id}</Tech>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-[13px]">{live ? 'Nothing — this is now.' : 'No new versions since then.'}</p>
      )}
    </Section>
  );
}
