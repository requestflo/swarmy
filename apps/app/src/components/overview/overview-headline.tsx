import * as React from 'react';
import type { EstateSummary } from '@/lib/use-estate-summary';

interface Headline {
  /** Words before the coral emphasis (may be empty). */
  lead: string;
  /** The one word that matters, rendered as coral `<em>`. */
  em: string;
}

/**
 * The Overview's one truthful status statement, derived from the settled
 * estate summary. Built from parts (lead + emphasised word) rather than string
 * surgery, so spacing and punctuation can't break.
 */
export function overviewHeadline(estate: EstateSummary): Headline {
  const { nodes, alerts, incidents } = estate;
  const needsYou = alerts.firing + incidents.open;
  if (nodes.total === 0) return { lead: 'Let’s get you', em: 'live' };
  if (needsYou > 0) {
    return needsYou === 1
      ? { lead: 'One thing needs', em: 'you' }
      : { lead: `${needsYou} things need`, em: 'you' };
  }
  if (nodes.online === nodes.total) return { lead: 'All', em: 'green' };
  const down = nodes.total - nodes.online;
  return { lead: `${down} of ${nodes.total} nodes`, em: 'offline' };
}

/** Eyebrow + display headline for the Overview. */
export function OverviewHeadline({ estate }: { estate: EstateSummary }): React.JSX.Element {
  const { lead, em } = overviewHeadline(estate);
  return (
    <div className="mb-8">
      <span className="eyebrow">Overview</span>
      <h1 className="headline mt-3 text-[2.2rem] sm:text-5xl">
        {lead ? `${lead} ` : ''}
        <em>{em}</em>.
      </h1>
      <p className="text-muted-foreground mt-2 text-sm sm:text-base">
        Your whole estate, one screen. Every card below opens the workspace that owns it.
      </p>
    </div>
  );
}
