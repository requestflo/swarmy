import * as React from 'react';
import { Say, SayHeader } from '@/components/calm';
import { plural } from './app-words';
import { clockWords } from './app-board-words';
import type { SayParts } from './estate-say';

export interface EstateCounts {
  apps: number;
  parts: number;
  needsYou: number;
  /** undefined until the servers answer (never a fake zero). */
  servers: number | undefined;
  regions: number;
}

/** Top-bar facts: "1 needs you" and "4 apps · 12 parts · 4 servers · 3 regions". */
export function AppsTopMeta({ c }: { c: EstateCounts }): React.JSX.Element {
  const facts =
    c.apps === 0
      ? ['No apps yet', c.servers !== undefined ? `${plural(c.servers, 'server')} ready` : null]
      : [
          plural(c.apps, 'app'),
          plural(c.parts, 'part'),
          c.servers !== undefined ? plural(c.servers, 'server') : null,
          c.regions ? plural(c.regions, 'region') : null,
        ];
  return (
    <>
      {c.needsYou > 0 ? (
        <span className="bg-status-warning/15 text-tone-warn inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-semibold">
          <span aria-hidden className="bg-status-warning size-1.5 rounded-full" />
          {c.needsYou} needs you
        </span>
      ) : null}
      <span className="text-muted-foreground hidden font-mono text-[12px] sm:inline">{facts.filter(Boolean).join(' · ')}</span>
    </>
  );
}

/** "RIGHT NOW · 10:42" · "4 apps. analytics needs you." · the lede with the numbers. */
export function AppsSay({ say, c }: { say: SayParts; c: EstateCounts }): React.JSX.Element {
  const where =
    c.servers !== undefined
      ? `, on ${plural(c.servers, 'server')}${c.regions ? ` in ${plural(c.regions, 'region')}` : ''}`
      : '';
  return (
    <SayHeader
      eyebrow={`Right now · ${clockWords(Date.now())}`}
      title={
        <>
          {say.lead} {say.clause ? <Say tone={say.clause.tone}>{say.clause.text}</Say> : null}
        </>
      }
      lede={`${plural(c.parts, 'part')} across ${plural(c.apps, 'app')}${where}. Open one to see how it is built.`}
    />
  );
}
