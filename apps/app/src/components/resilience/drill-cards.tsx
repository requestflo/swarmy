import * as React from 'react';
import { CheckCircle2Icon, CircleDashedIcon, XCircleIcon } from 'lucide-react';
import type { ResilienceDrillCardView, ResilienceDrillTargetView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import {
  DRILL_BLURBS,
  DRILL_TITLES,
  formatDurationMs,
  formatDurationSec,
  relativeTime,
} from './format';
import { RunDrillDialog } from './run-drill-dialog';

function lastLine(card: ResilienceDrillCardView): {
  text: string;
  tone: 'ok' | 'bad' | 'none';
} {
  if (!card.last) return { text: 'Never run — untested is unproven.', tone: 'none' };
  const when = relativeTime(card.last.at);
  if (card.last.status === 'failed') {
    return { text: `Last run failed, ${when}.`, tone: 'bad' };
  }
  const bits = [`Last ${DRILL_TITLES[card.kind].toLowerCase()}: successful, ${when}`];
  if (card.kind === 'restore') {
    if (card.rpoSeconds != null) bits.push(`RPO ${formatDurationSec(card.rpoSeconds)}`);
    if (card.rtoEstimateMs != null) bits.push(`RTO ${formatDurationMs(card.rtoEstimateMs)} estimate`);
  } else {
    bits.push(`took ${formatDurationMs(card.last.durationMs)}`);
  }
  return { text: bits.join(' · '), tone: 'ok' };
}

function DrillCard({
  card,
  targets,
}: {
  card: ResilienceDrillCardView;
  targets: ResilienceDrillTargetView[];
}): React.JSX.Element {
  const line = lastLine(card);
  const Icon =
    line.tone === 'ok' ? CheckCircle2Icon : line.tone === 'bad' ? XCircleIcon : CircleDashedIcon;
  return (
    <div className="card-pop flex flex-col gap-3 p-5">
      <div>
        <h3 className="text-sm font-bold">{DRILL_TITLES[card.kind]}</h3>
        <p className="text-muted-foreground mt-1 text-xs">{DRILL_BLURBS[card.kind]}</p>
      </div>
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            line.tone === 'ok' && 'text-status-online',
            line.tone === 'bad' && 'text-status-offline',
            line.tone === 'none' && 'text-muted-foreground',
          )}
        />
        <p className="mono-label text-muted-foreground normal-case">{line.text}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        {card.available ? (
          <span className="text-status-online mono-label">Ready</span>
        ) : (
          <span className="text-muted-foreground text-xs">{card.unavailableReason}</span>
        )}
        <RunDrillDialog
          kind={card.kind}
          targets={targets}
          disabled={!card.available}
          disabledReason={card.unavailableReason}
        />
      </div>
    </div>
  );
}

/** The three drill cards: last result line, RPO/RTO, run buttons w/ confirm. */
export function DrillCards({
  drills,
  targets,
}: {
  drills: ResilienceDrillCardView[];
  targets: ResilienceDrillTargetView[];
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-bold">Safe drills</h2>
        <p className="text-muted-foreground text-xs">
          Prove your recovery story on a schedule, not during an outage. Every run is audited.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {drills.map((d) => (
          <DrillCard key={d.kind} card={d} targets={targets} />
        ))}
      </div>
    </section>
  );
}
