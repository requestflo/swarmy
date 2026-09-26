import * as React from 'react';
import type { AlertEventView, AlertSelector } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_DOT } from '@/components/calm';
import { WEEK_MS, spanWords, weekHistory } from './rule-history';
import { resourceName } from './rule-sentence';

const W = 700;
const H = 64;
const DAY = WEEK_MS / 7;
const when = (t: number): string =>
  new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

interface RuleHistoryChartProps {
  events: AlertEventView[];
  signal: string;
  /** The rule's target: only its subjects count. */
  selector: AlertSelector;
  /** The draft's threshold / duration differ from what's saved. */
  changed: boolean;
  /** The event page came back full (200), so the week may be cut short. */
  pageFull: boolean;
}

/**
 * LAST 7 DAYS · REAL DATA: every time this signal fired, from the event feed.
 * It is the history of the saved rule — an unsaved threshold has none yet.
 */
export function RuleHistoryChart({ events, signal, selector, changed, pageFull }: RuleHistoryChartProps): React.JSX.Element {
  const [now] = React.useState(() => Date.now());
  const { fires, partial } = weekHistory(events, signal, now, pageFull, selector);
  const from = now - WEEK_MS;
  const x = (t: number): number => ((t - from) / WEEK_MS) * W;
  const last = fires.at(-1);
  const n = fires.length;
  return (
    <section aria-label="The last 7 days" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">Last 7 days · real data</span>
        {n > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
            <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT.bad)} />
            Fired {partial ? 'at least ' : ''}
            {n}× this week
          </span>
        ) : null}
      </div>
      {n === 0 ? (
        <p className="text-muted-foreground text-sm">Quiet all week: this didn’t fire in the last 7 days.</p>
      ) : (
        <>
          <div className="border-border overflow-hidden rounded-lg border">
            <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Fired ${n} times in the last 7 days`} className="block h-auto w-full">
              {Array.from({ length: 7 }, (_, d) => (
                <g key={d}>
                  <line x1={(d * W) / 7} x2={(d * W) / 7} y1={0} y2={H} className="stroke-border" strokeWidth={1} />
                  <text x={(d * W) / 7 + 6} y={H + 13} className="fill-muted-foreground font-mono text-[10px]">
                    {new Date(from + d * DAY + DAY / 2).toLocaleDateString('en-GB', { weekday: 'short' })}
                  </text>
                </g>
              ))}
              <line x1={0} x2={W} y1={H - 1} y2={H - 1} className="stroke-border" strokeWidth={1} />
              {fires.map((f) => (
                <rect
                  key={f.start}
                  x={x(f.start)}
                  y={10}
                  width={Math.max(4, x(f.end ?? now) - x(f.start))}
                  height={H - 11}
                  rx={2}
                  className={f.critical ? 'fill-status-offline' : 'fill-status-warning'}
                >
                  <title>{`${when(f.start)} · ${spanWords((f.end ?? now) - f.start)}${f.end === null ? ' · firing now' : ''} · ${resourceName(f.resource)}`}</title>
                </rect>
              ))}
            </svg>
          </div>
          {last ? (
            <p className="text-muted-foreground font-mono text-[11.5px]">
              last {when(last.start)} · {last.end === null ? `${spanWords(now - last.start)} · firing now` : `lasted ${spanWords(last.end - last.start)}`} ·{' '}
              {resourceName(last.resource)}
            </p>
          ) : null}
        </>
      )}
      {changed ? (
        <p className="text-muted-foreground text-xs">This is what really fired under the rule in charge today. A new setting has no history to test against yet.</p>
      ) : null}
    </section>
  );
}
