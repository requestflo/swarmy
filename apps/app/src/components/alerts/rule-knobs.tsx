import * as React from 'react';
import type { NotificationChannelView } from '@swarmy/core';
import { Input, cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { DURATION_PRESETS, formatDuration, formatValue, phraseFor } from './signal-phrases';
import type { RuleDraft } from './use-rule-draft';

const chip = (on: boolean): string =>
  cn(
    'h-8 rounded-lg border px-2.5 font-mono text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
    on ? 'bg-foreground text-background border-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
  );

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-muted-foreground w-24 shrink-0 text-[13px]">{label}</span>
      {children}
    </div>
  );
}

interface RuleKnobsProps {
  draft: RuleDraft;
  channels: NotificationChannelView[];
  patch: (p: Partial<RuleDraft>) => void;
  ids: { value: string; duration: string; channels: string };
}

/** Threshold presets, the for-at-least presets and the channel chips; free inputs at Controls. */
export function RuleKnobs({ draft, channels, patch, ids }: RuleKnobsProps): React.JSX.Element {
  const p = phraseFor(draft.signal);
  const toggle = (id: string): void =>
    patch({ channelIds: draft.channelIds.includes(id) ? draft.channelIds.filter((x) => x !== id) : [...draft.channelIds, id] });
  return (
    <div className="flex flex-col gap-3">
      {p.op !== null ? (
        <Row label="Threshold">
          {p.presets.map((v, i) => (
            <button key={v} id={i === 0 ? ids.value : undefined} type="button" aria-pressed={draft.threshold === v} className={chip(draft.threshold === v)} onClick={() => patch({ threshold: v })}>
              {formatValue(draft.signal, v)}
            </button>
          ))}
          <Depth at="controls">
            <Input
              type="number"
              aria-label="Exact threshold"
              className="h-8 w-24 font-mono"
              value={draft.threshold ?? ''}
              onChange={(e) => patch({ threshold: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </Depth>
        </Row>
      ) : null}
      {p.held ? (
        <Row label="For at least">
          {DURATION_PRESETS.map((s, i) => (
            <button key={s} id={i === 0 ? ids.duration : undefined} type="button" aria-pressed={draft.forSeconds === s} className={chip(draft.forSeconds === s)} onClick={() => patch({ forSeconds: s })}>
              {formatDuration(s)}
            </button>
          ))}
          <Depth at="controls">
            <Input
              type="number"
              min={0}
              max={86_400}
              aria-label="Exact duration in seconds"
              className="h-8 w-24 font-mono"
              value={draft.forSeconds}
              onChange={(e) => patch({ forSeconds: Math.max(0, Math.min(86_400, Math.round(Number(e.target.value) || 0))) })}
            />
            <span className="text-muted-foreground font-mono text-[11.5px]">seconds</span>
          </Depth>
        </Row>
      ) : null}
      <Row label="Tell">
        <button id={ids.channels} type="button" aria-pressed={draft.channelIds.length === 0} className={chip(draft.channelIds.length === 0)} onClick={() => patch({ channelIds: [] })}>
          Every channel
        </button>
        {channels.map((c) => (
          <button key={c.id} type="button" aria-pressed={draft.channelIds.includes(c.id)} className={chip(draft.channelIds.includes(c.id))} onClick={() => toggle(c.id)}>
            {c.name}
          </button>
        ))}
      </Row>
    </div>
  );
}
