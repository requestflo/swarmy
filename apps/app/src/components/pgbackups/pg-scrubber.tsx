import * as React from 'react';
import { Input, cn } from '@swarmy/ui';
import { Depth, Tech, useDepth } from '@/components/calm';
import {
  formatPit,
  nudgePit,
  parsePit,
  pitAxis,
  pitInput,
  pitSegments,
  segmentOf,
  type PitSpan,
} from './pitr-scrub';

interface PgScrubberProps {
  span: PitSpan;
  value: number;
  onChange: (ms: number) => void;
  /** Stretches no restore can reach (a WAL gap up to the next base copy), shaded. */
  blocked?: ReadonlyArray<{ fromMs: number; toMs: number }>;
}

/**
 * Pick the second to restore to: a strip across the restorable window
 * (click a block to jump), the ±10 s stepper, and an exact UTC time at
 * Controls. The value never leaves the window.
 */
export function PgScrubber({ span, value, onChange, blocked = [] }: PgScrubberProps): React.JSX.Element {
  const { atLeast } = useDepth();
  const segs = React.useMemo(() => pitSegments(span), [span]);
  const axis = React.useMemo(() => pitAxis(span), [span]);
  const on = segmentOf(value, span);
  const [text, setText] = React.useState(() => pitInput(value));
  const [bad, setBad] = React.useState<string | null>(null);
  React.useEffect(() => setText(pitInput(value)), [value]);

  const apply = (): void => {
    const ms = parsePit(text);
    if (ms == null) return setBad('Write it as YYYY-MM-DD HH:MM:SS.');
    if (ms < span.fromMs || ms > span.toMs) {
      return setBad(`Pick a time between ${pitInput(span.fromMs)} and ${pitInput(span.toMs)}.`);
    }
    setBad(null);
    onChange(ms);
  };
  const step = 'size-8 text-base hover:bg-accent disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11';

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="Jump to a time" className="flex h-9 overflow-hidden rounded-[10px] bg-[var(--code)]">
        {segs.map((g) => {
          const gap = blocked.some((b) => g.startMs < b.toMs && g.endMs > b.fromMs);
          return (
          <button
            key={g.index}
            type="button"
            aria-label={`Jump to ${formatPit(g.midMs)} UTC${gap ? ' (touches a WAL gap)' : ''}`}
            aria-pressed={g.index === on}
            onClick={() => onChange(g.midMs)}
            // A strip of blocks, not a row of buttons: the touch rule's 44px min-width
            // would push it past a phone (the ±10 s stepper is the touch-sized way).
            style={{ minWidth: 0 }}
            className={cn(
              'flex-1 border-r border-[var(--code)] outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
              g.index === on ? 'bg-primary' : gap ? 'bg-status-warning/45 hover:bg-status-warning/60' : 'bg-status-progress/25 hover:bg-status-progress/45',
            )}
          />
          );
        })}
      </div>
      <div aria-hidden className="text-muted-foreground flex justify-between font-mono text-[11px]">
        {axis.map((a) => (
          <span key={a.frac}>{a.label}</span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <div className="border-input inline-flex items-center overflow-hidden rounded-[10px] border">
          <button type="button" aria-label="Ten seconds earlier" className={step} disabled={value <= span.fromMs} onClick={() => onChange(nudgePit(value, -1, span))}>
            −
          </button>
          <span aria-live="polite" className="min-w-48 px-2 text-center font-mono text-[13px]">
            {formatPit(value)}
          </span>
          <button type="button" aria-label="Ten seconds later" className={step} disabled={value >= span.toMs} onClick={() => onChange(nudgePit(value, 1, span))}>
            +
          </button>
        </div>
        <span className="text-muted-foreground text-xs">
          UTC · ±10 s{atLeast('controls') ? '' : ' · type an exact time at Controls'}
        </span>
      </div>
      <Depth at="controls">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs font-semibold">Exact time (UTC)</span>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={apply}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              className="w-60 font-mono"
              aria-invalid={bad != null}
            />
          </label>
          {bad ? <span className="text-tone-bad pb-2 text-xs">{bad}</span> : null}
        </div>
        <Tech>
          recovery target {new Date(value).toISOString()} · window {new Date(span.fromMs).toISOString()} → {new Date(span.toMs).toISOString()}
        </Tech>
      </Depth>
    </div>
  );
}
