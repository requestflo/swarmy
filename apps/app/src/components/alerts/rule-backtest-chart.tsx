import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_DOT, Tech } from '@/components/calm';
import { backtest, coarsen, envelope, type BacktestGrid, type BacktestSubject, type WouldFire } from './rule-backtest';
import { spanWords } from './rule-history';
import { formatDuration, formatValue } from './signal-phrases';

const W = 700;
const H = 104;
/** 30-minute points: 336 for the week. */
const COARSE = 6;
const when = (t: number): string => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const pct = (v: number): string => `${v < 10 ? v.toFixed(1) : Math.round(v * 10) / 10}%`;
/** A reading in the signal's unit: "86.3%" · "2,600 jobs". */
const readingOf = (signal: string) => (v: number): string => (signal === 'queue-depth' ? `${Math.round(v).toLocaleString('en-GB')} jobs` : pct(v));
const SERIES: Record<string, string> = { 'disk-usage': 'Disk used', 'queue-depth': 'Waiting jobs', 'error-rate': 'Error rate' };

interface RuleBacktestChartProps {
  signal: string;
  grid: BacktestGrid;
  subjects: BacktestSubject[];
  threshold: number | null;
  forSeconds: number;
  tech: string;
  /** Real fires in the alert feed under the saved rule (null for a new rule). */
  realFires: number | null;
}

/**
 * LAST 7 DAYS · REAL DATA: the week's readings with the draft's threshold
 * line, and every stretch where the rule — as it stands in the editor —
 * would have fired, replayed by the evaluator's own gate (rule-backtest.ts).
 */
export function RuleBacktestChart({ signal, grid, subjects, threshold, forSeconds, tech, realFires }: RuleBacktestChartProps): React.JSX.Element {
  const r = React.useMemo(() => backtest(subjects, grid, threshold, forSeconds), [subjects, grid, threshold, forSeconds]);
  const line = React.useMemo(() => coarsen(envelope(subjects, grid.slots), COARSE), [subjects, grid.slots]);
  const to = grid.from + grid.slots * grid.stepMs;
  const peak = React.useMemo(() => peakOf(subjects), [subjects]);
  const known = line.filter((v): v is number => v !== null);
  const disk = signal === 'disk-usage';
  const reading = readingOf(signal);
  const top = Math.max(peak?.v ?? 0, threshold ?? 0);
  const low = disk ? Math.max(0, Math.floor(Math.min(...known, threshold ?? 100) - 5)) : 0;
  const high = disk ? Math.min(100, Math.ceil(top + 5)) : Math.max(1, top * 1.25);
  const x = (t: number): number => ((t - grid.from) / (to - grid.from)) * W;
  const y = (v: number): number => H - ((v - low) / (high - low || 1)) * H;
  const path = line.map((v, i) => (v === null ? '' : `${i === 0 || line[i - 1] === null ? 'M' : 'L'}${x(grid.from + (i + 0.5) * COARSE * grid.stepMs).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
  const n = r.fires.length;
  const last = r.fires.at(-1);
  const thr = formatValue(signal, threshold);
  const held = forSeconds > 0 ? ` for ${formatDuration(forSeconds)}` : '';
  const blips = r.blips ? `${r.blips} shorter blip${r.blips === 1 ? '' : 's'} ignored by the duration` : '';
  const days = midnights(grid.from, to);
  const lasted = (f: WouldFire): string => (f.start <= grid.from && f.open ? 'all week' : spanWords(f.end - f.start));

  return (
    <section aria-label="The last 7 days, replayed" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">Last 7 days · real data</span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
          <span aria-hidden className={cn('size-2 rounded-full', n ? TONE_DOT.bad : TONE_DOT.ok)} />
          {threshold === null ? 'Set a threshold to replay the week' : n ? `Would have fired ${n}× this week` : 'Would have stayed quiet'}
        </span>
      </div>
      <div className="border-border relative overflow-hidden rounded-lg border" style={{ height: H + 22 }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${SERIES[signal] ?? 'Readings'} over the last 7 days against the ${thr} line: would have fired ${n} times`} className="absolute inset-x-0 top-0 w-full" style={{ height: H }}>
          {days.map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {r.fires.map((f) => (
            // A week is wide: every fire gets at least ~1% of it, with a solid cap so a short one still shows.
            <g key={`${f.subject}-${f.start}`} className="fill-status-offline">
              <title>{`${when(f.start)} · ${lasted(f)}${f.open ? ' · firing now' : ''} · ${f.subject} · peak ${reading(f.peak)}`}</title>
              <rect x={x(f.start)} width={Math.max(7, x(f.end) - x(f.start))} y={0} height={H} fillOpacity={0.2} />
              <rect x={x(f.start)} width={Math.max(7, x(f.end) - x(f.start))} y={0} height={4} />
            </g>
          ))}
          <path d={path} fill="none" className="text-tone-info" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {threshold !== null ? (
            <line x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} className="text-tone-bad" stroke="currentColor" strokeWidth={1} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        {threshold !== null ? (
          <span className="text-tone-bad bg-card absolute right-1 px-1 font-mono text-[10.5px]" style={{ top: Math.max(0, Math.min(H - 14, y(threshold) - 15)) }}>{thr}</span>
        ) : null}
        {days.map((t) => (
          <span key={t} className="text-muted-foreground absolute bottom-1 font-mono text-[10px]" style={{ left: `calc(${(x(t) / W) * 100}% + 6px)` }}>
            {new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })}
          </span>
        ))}
      </div>
      {threshold === null ? null : last ? (
        <p className="text-muted-foreground font-mono text-[11.5px]">
          last {when(last.start)} · {lasted(last)} · {last.subject}
          {last.open ? ' · firing now' : ''}
          {blips ? ` · ${blips}` : ''}
        </p>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          Nothing crossed {thr}{held}, so this rule would have stayed quiet.{peak ? ` Peak this week ${reading(peak.v)} on ${peak.subject}` : ''}
          {blips ? ` · ${blips}.` : peak ? '.' : ''}
        </p>
      )}
      {realFires !== null ? (
        <p className="text-muted-foreground text-xs">
          The alert feed shows the saved rule really fired {realFires}× this week. The live check runs every 30 s on the newest readings, so the two can differ a little.
        </p>
      ) : null}
      <Tech>{tech}</Tech>
    </section>
  );
}

/** Local midnights inside the window: one tick and weekday per day. */
function midnights(from: number, to: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  for (; d.getTime() < to; d.setDate(d.getDate() + 1)) out.push(d.getTime());
  return out;
}

function peakOf(subjects: BacktestSubject[]): { v: number; subject: string } | null {
  let best: { v: number; subject: string } | null = null;
  for (const s of subjects) for (const v of s.values) if (v !== null && (!best || v > best.v)) best = { v, subject: s.name };
  return best;
}
