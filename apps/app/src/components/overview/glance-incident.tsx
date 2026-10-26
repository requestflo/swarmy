import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AlertEventView, IncidentDetailView, IncidentView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { CardSkeleton, TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { clockWords } from '@/components/apps/app-board-words';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { METRIC_TITLE, linePath, seriesFor, type ChartPoint } from '@/components/incidents/incident-chart-model';
import { incidentMetric, type IncidentMetric } from '@/components/incidents/incident-scope';
import { plainWords } from '@/components/incidents/incident-words';
import { useIncidentEvidence } from '@/components/incidents/use-incident-evidence';
import { useIncidentScope } from '@/components/incidents/use-incident-scope';
import { GlanceHold } from './glance-hold';
import { alsoFiring, causeLines, incidentAlerts, metricLine } from './glance-words';
import { OverviewNext, pickNext } from './overview-next';
import type { GlanceActions } from './use-glance-actions';
import { useLastRollback } from './use-last-rollback';

/**
 * The open incident on a phone: what's wrong and since when, the incident
 * room's best guess as a sentence (with the metric before vs now, and how
 * long the last rollback took), the chart as a sparkline, who has it (Take it
 * for 30 min), Put back / Ack inline, and what else is firing.
 */
export function GlanceIncident({ incident, firing, actions }: { incident: IncidentView; firing: AlertEventView[]; actions: GlanceActions }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.incidents.get.queryOptions({ id: incident.id }), refetchInterval: 15_000 });
  // No detail (it failed to load): the desktop's next action for it, so the way in stays.
  if (q.isError) return <OverviewNext next={pickNext([incident], [], [], [])!} />;
  if (!q.data) return <CardSkeleton lines={3} />;
  return <IncidentBody d={q.data} firing={firing} actions={actions} />;
}

/** The incident chart's own query (same key, so the room and the glance share it). */
function useMetricSeries(app: string | null, metric: IncidentMetric | null): ChartPoint[] | undefined {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.observability.requestSeries.queryOptions({ stack: app ?? '', windowMinutes: 180, bucketSeconds: 180 }),
    enabled: app !== null && metric !== null,
    refetchInterval: 30_000,
  });
  if (!app || !metric) return [];
  if (q.isPending) return undefined;
  return q.data?.status === 'ok' ? seriesFor(metric, q.data.points) : [];
}

function IncidentBody({ d, firing, actions }: { d: IncidentDetailView; firing: AlertEventView[]; actions: GlanceActions }): React.JSX.Element {
  const { scope, ctx, inventory, releases } = useIncidentScope(d);
  const { guess } = useIncidentEvidence(d, scope, inventory, releases);
  const metric = incidentMetric(scope, d.title);
  const series = useMetricSeries(scope.app, metric);
  const { linked, others } = incidentAlerts(d.events, firing);
  const putBack = guess?.cause === 'deploy' ? guess.putBack : null;
  const label = putBack ? releaseLabel(putBack) : null;
  const last = useLastRollback(putBack ? putBack.stackName : null);
  const tone: Tone = d.severity === 'critical' ? 'bad' : 'warn';
  const lines = guess && series && last !== undefined ? [metricLine(metric, series, d.openedAt), ...causeLines(guess, label, last?.tookSec ?? null)].filter(Boolean) : null;
  const also = alsoFiring(others);
  const room = { to: '/activity', search: { incident: d.id } } as const;

  return (
    <section aria-label="Needs you" className={cn('calm-card flex flex-col gap-3 p-4', tone === 'bad' ? 'border-status-offline/45' : 'border-status-warning/45')}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full motion-safe:animate-pulse', TONE_DOT[tone])} />
        <Link {...room} className="-my-3 min-w-0 flex-1 py-3 text-[16px] leading-snug font-semibold">
          {plainWords(d.title, ctx)}
        </Link>
        <span className="text-muted-foreground mt-[3px] shrink-0 font-mono text-[11px]">since {clockWords(d.openedAt)}</span>
      </div>
      {lines ? <p className="text-foreground/80 text-[14px] leading-normal">{lines.join(' ')}</p> : <TextSkeleton className="w-4/5" />}
      {metric && series && series.length >= 2 ? <Spark points={series} tone={tone} label={`${METRIC_TITLE[metric]}, last 3 hours`} /> : null}
      <GlanceHold incidentId={d.id} owner={d.owner} />
      <div className="flex gap-2">
        {putBack && label ? (
          <Button className="h-11 flex-1" disabled={actions.busy} onClick={() => actions.putBack(d.id, putBack, guess?.suspect ?? null)}>
            Put back {label}
          </Button>
        ) : (
          <Button asChild className="h-11 flex-1">
            <Link {...room}>Open the incident</Link>
          </Button>
        )}
        {linked.length ? (
          <Button variant="secondary" className="h-11 flex-1" disabled={actions.busy} aria-label="Acknowledge the alerts" onClick={() => actions.ack(d.id, linked)}>
            Ack
          </Button>
        ) : null}
      </div>
      {also ? <p className="text-muted-foreground text-[12.5px] leading-snug">{also}</p> : null}
      <Tech>
        {d.id} · {d.severity} · incidents.{d.owner?.mine ? 'release' : 'take'}
        {putBack ? ` · releases.rollback ${putBack.id}` : ''}
        {last ? ` · last ${last.releaseId} ${last.tookSec} s` : ''}
        {linked.length ? ` · alerts.ack ${linked.map((a) => a.id).join(', ')}` : ''}
      </Tech>
    </section>
  );
}

function Spark({ points, tone, label }: { points: ChartPoint[]; tone: Tone; label: string }): React.JSX.Element {
  const from = points[0]!.t;
  const to = points.at(-1)!.t;
  const max = Math.max(...points.map((p) => p.v)) * 1.1;
  return (
    <svg viewBox="0 0 320 30" preserveAspectRatio="none" role="img" aria-label={label} className={cn('block h-[30px] w-full', TONE_TEXT[tone])}>
      <path d={linePath(points, from, to, max, 320, 28)} fill="none" stroke="currentColor" strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
