import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReleaseView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { METRIC_TITLE, formatValue, linePath, releaseMarkers, seriesFor, valueTone, type ChartPoint } from './incident-chart-model';
import type { IncidentMetric } from './incident-scope';

const WINDOW_MIN = 180;
const BUCKET_SEC = 180;
const W = 600;
const H = 112;

/**
 * The metric that best explains the incident over the last 3 h, with a dotted
 * marker at each release. No series → a quiet line, never an empty chart.
 */
export function IncidentChart({ app, metric, releases, address }: { app: string | null; metric: IncidentMetric | null; releases: ReleaseView[] | undefined; address: string | null }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.observability.requestSeries.queryOptions({ stack: app ?? '', windowMinutes: WINDOW_MIN, bucketSeconds: BUCKET_SEC }),
    enabled: app !== null && metric !== null,
    refetchInterval: 30_000,
  });
  if (!app || !metric) return <Quiet text="No chart for this kind of incident." />;
  if (q.isPending) return <CardSkeleton />;
  const points = q.data?.status === 'ok' ? seriesFor(metric, q.data.points) : [];
  if (points.length < 2) {
    const why = q.data?.status === 'disabled' ? `telemetry is off for ${app}` : q.data?.status === 'unreachable' ? 'the telemetry store isn’t answering' : `${app} sent no requests to chart yet`;
    return <Quiet text={`No chart yet: ${why}.`} />;
  }
  const to = Date.now();
  const from = to - WINDOW_MIN * 60_000;
  const last = points.at(-1)!;
  return (
    <section aria-label={`${METRIC_TITLE[metric]}, last 3 hours`} className="calm-card flex flex-col gap-3 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h2 className="font-display text-[15px] font-bold">{METRIC_TITLE[metric]}</h2>
          <span className="text-muted-foreground font-mono text-[11.5px]">{address ?? app} · last 3 h</span>
        </div>
        <span className={cn('font-mono text-[22px] leading-none font-semibold tabular-nums', TONE_TEXT[valueTone(metric, last.v)])}>{formatValue(metric, last.v)}</span>
      </div>
      <Plot points={points} from={from} to={to} metric={metric} markers={releaseMarkers(releases ?? [], from, to)} />
      <Tech>observability.requestSeries · stack {app} · entry spans · {BUCKET_SEC / 60}-minute buckets · {metric === 'errors' ? 'errors ÷ calls' : 'p95 duration'}</Tech>
    </section>
  );
}

function Quiet({ text }: { text: string }): React.JSX.Element {
  return <p className="text-muted-foreground px-1 text-[13px]">{text}</p>;
}

function Plot({ points, from, to, metric, markers }: { points: ChartPoint[]; from: number; to: number; metric: IncidentMetric; markers: Array<{ t: number; label: string }> }): React.JSX.Element {
  const [hover, setHover] = React.useState<ChartPoint | null>(null);
  const peak = Math.max(...points.map((p) => p.v));
  const typical = [...points].sort((a, b) => a.v - b.v)[Math.floor(points.length / 2)]!.v;
  const max = peak * 1.15 || 1;
  const x = (t: number): number => ((t - from) / (to - from)) * 100;
  const y = (v: number): number => (1 - v / max) * H;
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - box.left) / box.width) * (to - from);
    setHover(points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)));
  };
  const grid = [peak, typical].filter((v, i, a) => i === 0 || Math.abs(y(v) - y(a[0]!)) > 18);
  return (
    <div className="relative pb-5" style={{ height: H + 20 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-x-0 top-0 w-full overflow-visible" style={{ height: H }} aria-hidden>
        {grid.map((v) => (
          <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {markers.map((m) => (
          <line key={m.t} x1={(x(m.t) / 100) * W} x2={(x(m.t) / 100) * W} y1={0} y2={H} className="text-tone-info" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={linePath(points, from, to, max, W, H)} fill="none" className={TONE_TEXT[valueTone(metric, points.at(-1)!.v)]} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {grid.map((v) => (
        <span key={v} className="text-muted-foreground bg-card absolute left-0 px-0.5 font-mono text-[10.5px]" style={{ top: Math.max(0, y(v) - 15) }}>{formatValue(metric, v)}</span>
      ))}
      {markers.map((m) => (
        <span key={m.t} className="text-tone-info absolute bottom-0 font-mono text-[10.5px] whitespace-nowrap" style={x(m.t) > 70 ? { right: `${100 - x(m.t)}%`, paddingRight: 4 } : { left: `${x(m.t)}%`, paddingLeft: 4 }}>{m.label}</span>
      ))}
      {hover ? (
        <>
          <span aria-hidden className="bg-foreground/30 absolute top-0 w-px" style={{ left: `${x(hover.t)}%`, height: H }} />
          <span className="bg-popover text-popover-foreground absolute top-0 rounded-md border px-2 py-1 font-mono text-[11px] whitespace-nowrap shadow-sm" style={x(hover.t) > 60 ? { right: `${100 - x(hover.t)}%`, marginRight: 6 } : { left: `${x(hover.t)}%`, marginLeft: 6 }}>
            {new Date(hover.t).toTimeString().slice(0, 5)} · {formatValue(metric, hover.v)}
          </span>
        </>
      ) : null}
      <table className="sr-only">
        <caption>{METRIC_TITLE[metric]}</caption>
        <tbody>{points.map((p) => <tr key={p.t}><td>{new Date(p.t).toTimeString().slice(0, 5)}</td><td>{formatValue(metric, p.v)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
