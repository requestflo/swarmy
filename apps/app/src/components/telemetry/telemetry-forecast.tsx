import * as React from 'react';
import type { TelemetryForecastView, TelemetryProjection, TelemetrySettings, TelemetrySignal } from '@swarmy/core';
import { Section, TONE_TEXT } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { FIT_WORDS, forecastLine, gb } from './telemetry-copy';

const TITLE: Record<TelemetrySignal, string> = { traces: 'Traces', logs: 'Logs', metrics: 'Metrics' };
const W = 600;
const H = 180;

/** The projected-usage area under the disk's ceiling (used now + free now). */
function ForecastChart({ p, f }: { p: TelemetryProjection; f: TelemetryForecastView }): React.JSX.Element | null {
  if (!p.points) return null;
  const ceiling = f.usedBytes !== null && f.freeBytes !== null ? f.usedBytes + f.freeBytes : null;
  const top = Math.max(ceiling ?? 0, ...p.points) * 1.08 || 1;
  const x = (d: number) => (d / p.days) * W;
  const y = (b: number) => H - (b / top) * H;
  const line = p.points.map((b, d) => `${d === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(b).toFixed(1)}`).join(' ');
  const last = p.points[p.points.length - 1] ?? 0;
  return (
    <div className="flex flex-col gap-1">
      {ceiling !== null ? (
        <span className="text-tone-warn font-mono text-[11px]">
          - - {f.node ?? 'store server'} full at {gb(ceiling, 0)} · {gb(f.freeBytes, 0)} free today
        </span>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="text-chart-3 block h-44 w-full" role="img" aria-label={`Projected use grows from ${gb(p.points[0])} to ${gb(last)} over ${p.days} days`}>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill="currentColor" fillOpacity={0.14} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {ceiling !== null ? (
          <line x1={0} x2={W} y1={y(ceiling)} y2={y(ceiling)} className="text-tone-warn" stroke="currentColor" strokeDasharray="5 5" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="text-muted-foreground mt-1 flex justify-between font-mono text-[11px]">
        <span>today · {gb(p.points[0])}</span>
        <span>+{p.days} days · {gb(last)}</span>
      </div>
    </div>
  );
}

/** DISK FORECAST · NEXT 30 DAYS: measured size and rate, projected under the draft. */
export function TelemetryForecast({
  f,
  p,
  s,
}: {
  f: TelemetryForecastView | undefined;
  p: TelemetryProjection | null;
  s: TelemetrySettings;
}): React.JSX.Element {
  if (!f || !p) return <CardSkeleton />;
  const fit = p.fit ? FIT_WORDS[p.fit] : null;
  const line = forecastLine(s, p, f.node, f.freeBytes);
  return (
    <Section
      title={<span className="text-muted-foreground font-mono text-[12px] font-medium tracking-[0.08em] uppercase">Disk forecast · next {p.days} days</span>}
      action={fit ? <span className={`text-xs font-semibold ${TONE_TEXT[fit.tone]}`}>{fit.word}</span> : null}
    >
      {f.status !== 'ok' ? (
        <p className="text-muted-foreground text-[13px]">
          {f.status === 'disabled' ? 'Nothing is stored yet, so there is nothing to project.' : 'The store isn’t answering, so there are no numbers to project.'}
        </p>
      ) : (
        <>
          {p.points ? <ForecastChart p={p} f={f} /> : <p className="text-muted-foreground text-[13px]">Not enough days measured yet to project. It needs one full day of data.</p>}
          <div className="grid gap-2 sm:grid-cols-3">
            {p.perSignal.map((sig) => (
              <div key={sig.signal} className="border-border bg-background/60 flex flex-col rounded-xl border px-3 py-2">
                <span className="text-muted-foreground text-xs">{TITLE[sig.signal]}</span>
                <span className="font-mono text-[15px] font-semibold">{gb(sig.projectedBytes)}</span>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {sig.bytesPerDay !== null ? `${gb(sig.bytesPerDay, 2)}/day × ${sig.days} d` : 'rate not measured yet'}
                </span>
              </div>
            ))}
          </div>
          {line ? (
            <p className="text-[13.5px] leading-snug">
              {line} <span className="text-muted-foreground">Errors and slow traces are always kept, whatever the share.</span>
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}
