import * as React from 'react';
import type { PublicComponentView, PublicStatusView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { CurrentIncident, PublicIncidents } from './public-incidents';
import { UptimeBars } from './uptime-bars';
import { OVERALL_CLASSES, PUBLIC_STATUS_LABEL } from './status-tone';
import { bannerSentence } from './status-copy';

const WORD_TONE = { up: 'ok', degraded: 'warn', down: 'bad', unknown: 'idle' } as const;

function ComponentRow({ component }: { component: PublicComponentView }): React.JSX.Element {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{component.label}</p>
        <span className={cn('text-xs font-semibold', TONE_TEXT[WORD_TONE[component.status]])}>{PUBLIC_STATUS_LABEL[component.status]}</span>
      </div>
      {component.uptime90d.length > 0 ? (
        <>
          <UptimeBars days={component.uptime90d} className="mt-2 h-7" />
          <div className="text-muted-foreground mt-1 flex justify-between gap-2 font-mono text-[11px]">
            <span>90 days ago</span>
            <span>{component.uptimePct === null ? 'no data yet' : `${component.uptimePct}% uptime`}</span>
            <span>today</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The public status page itself — the same body on `/s/$slug` and in the
 * dashboard's live preview: title, the banner sentence, the ongoing incident
 * with its updates, per-component 90-day uptime, and the recent history.
 */
export function PublicStatusBody({ snapshot, compact }: { snapshot: PublicStatusView; compact?: boolean }): React.JSX.Element {
  const open = snapshot.incidents.filter((i) => i.status === 'open');
  const past = snapshot.incidents.filter((i) => i.status !== 'open');
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className={cn('font-display font-bold tracking-[-0.02em]', compact ? 'text-xl' : 'text-[2.2rem] leading-tight sm:text-5xl')}>{snapshot.page.title}</h1>
        {compact ? null : (
          <p className="text-muted-foreground mt-2 text-sm">
            Live status · updated <span className="mono-data">{new Date(snapshot.generatedAt).toLocaleTimeString()}</span>
          </p>
        )}
      </header>
      <div className={cn('flex items-center gap-3 rounded-xl px-4 py-3 font-semibold', compact ? 'text-[15px]' : 'text-base sm:text-lg', OVERALL_CLASSES[snapshot.overall])}>
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-current" />
        {bannerSentence(snapshot)}
      </div>
      {open.map((i) => (
        <CurrentIncident key={i.id} incident={i} />
      ))}
      {snapshot.components.length > 0 ? (
        <section aria-label="Components" className="divide-border flex flex-col divide-y">
          {snapshot.components.map((c) => (
            <ComponentRow key={c.key} component={c} />
          ))}
        </section>
      ) : null}
      {compact ? null : (
        <section>
          <h2 className="mono-label text-muted-foreground mb-3">Incident history</h2>
          <PublicIncidents incidents={past} />
        </section>
      )}
    </div>
  );
}
