import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { coarsen } from '@/components/alerts/rule-backtest';
import { CardSkeleton } from '@/components/states';
import { catchReleases, pctWords, receiptWords } from './catch-model';
import type { ErrorWeek } from './use-error-week';

const W = 700;
const H = 110;
/** 30-minute points: 336 for the week. */
const COARSE = 6;
const when = (t: number): string => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Error rate · last 7 days (board AppRollout): the part's week against the
 * canary's error ceiling, each release a tick, each crossing a dot — filled
 * when a canary would have caught it — and the receipt in a sentence.
 */
export function ErrorWeekChart({ week, tripPct, windowMin }: { week: ErrorWeek; tripPct: number; windowMin: number }): React.JSX.Element {
  if (week.state === 'pending') return <CardSkeleton lines={2} />;
  if (week.state === 'empty') return <p className="text-muted-foreground text-[13px]">{week.why}</p>;
  return <Chart week={week} tripPct={tripPct} windowMin={windowMin} />;
}

function Chart({ week, tripPct, windowMin }: { week: Extract<ErrorWeek, { state: 'ready' }>; tripPct: number; windowMin: number }): React.JSX.Element {
  const { grid, values, shipped } = week;
  const r = React.useMemo(() => catchReleases(values, grid, shipped, tripPct, windowMin), [values, grid, shipped, tripPct, windowMin]);
  const line = React.useMemo(() => coarsen(values, COARSE), [values]);
  const to = grid.from + grid.slots * grid.stepMs;
  const high = Math.max(1, Math.max(r.peak?.v ?? 0, tripPct) * 1.25);
  const x = (t: number): number => ((t - grid.from) / (to - grid.from)) * W;
  const y = (v: number): number => H - (v / high) * H;
  const path = line.map((v, i) => (v === null ? '' : `${i === 0 || line[i - 1] === null ? 'M' : 'L'}${x(grid.from + (i + 0.5) * COARSE * grid.stepMs).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
  const inWeek = shipped.filter((s) => s.at >= grid.from && s.at <= to);
  // Releases minutes apart share one label (the newer), so the axis stays legible.
  const labelled = inWeek.filter((s, i) => !inWeek[i + 1] || x(inWeek[i + 1]!.at) - x(s.at) > W * 0.08);
  const caught = r.crossings.filter((c) => c.caught).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="border-border relative overflow-hidden rounded-lg border" style={{ height: H + 22 }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Error rate over the last 7 days against a ${tripPct}% ceiling: ${caught} release${caught === 1 ? '' : 's'} caught`} className="absolute inset-x-0 top-0 w-full" style={{ height: H }}>
          {inWeek.map((s) => (
            <line key={s.at} x1={x(s.at)} x2={x(s.at)} y1={0} y2={H} className="stroke-foreground/25" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={path} fill="none" className="text-tone-info" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={y(tripPct)} y2={y(tripPct)} className="text-tone-warn" stroke="currentColor" strokeWidth={1} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        </svg>
        {r.crossings.map((c) => (
          <span
            key={c.start}
            title={`${when(c.start)} · ${pctWords(c.peak)}${c.after ? ` · after ${c.after.label}` : ''}${c.caught ? ' · caught' : ' · no canary watching'}`}
            aria-hidden
            className={cn('absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card', c.caught ? 'bg-status-offline' : 'bg-status-idle')}
            style={{ left: `${(x(c.start) / W) * 100}%`, top: Math.max(5, y(Math.min(c.peak, high))) }}
          />
        ))}
        <span className="text-tone-warn bg-card absolute right-1 px-1 font-mono text-[10.5px]" style={{ top: Math.max(0, Math.min(H - 14, y(tripPct) - 15)) }}>
          ceiling {tripPct}%
        </span>
        {labelled.map((s) => (
          <span key={s.at} className="text-muted-foreground absolute bottom-1 hidden -translate-x-1/2 font-mono text-[10px] sm:block" style={{ left: `${Math.min(95, Math.max(5, (x(s.at) / W) * 100))}%` }}>
            {s.label}
          </span>
        ))}
        <span className="text-muted-foreground absolute bottom-1 left-2 font-mono text-[10px] sm:hidden">error rate · 7 days</span>
      </div>
      <p className={cn('text-[13px]', caught ? 'text-foreground' : 'text-muted-foreground')}>{receiptWords(r, tripPct, windowMin, when)}</p>
      <Tech>{week.tech}</Tech>
    </div>
  );
}
