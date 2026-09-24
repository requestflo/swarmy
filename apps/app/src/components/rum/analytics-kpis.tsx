import * as React from 'react';
import { CountUp } from '@/components/count-up';
import { compact, pct, visitLength, type AnalyticsView } from './rum-shared';

interface AnalyticsKpisProps {
  data: AnalyticsView;
  identified: boolean;
}

/** Visitors · pageviews · bounce · visit length, plus the live count (refreshed every 15 s). */
export function AnalyticsKpis({ data, identified }: AnalyticsKpisProps): React.JSX.Element {
  const { kpis, live } = data;
  const perVisit = kpis.visits ? (kpis.pageviews / kpis.visits).toFixed(1) : '0';
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <div className="ink-block flex flex-col gap-1 rounded-2xl px-4 py-3">
        <span className="mono-label flex items-center gap-2 opacity-80">
          <span className="pulse-dot" aria-hidden /> Live now
        </span>
        <CountUp value={live.visitors} className="font-display text-3xl font-bold" />
        <span className="hidden text-xs opacity-75 sm:block">
          visitors in the last 5 min · {compact(live.pageviews)} views
        </span>
      </div>
      <Kpi label="Visitors" value={kpis.visits} sub={`last ${data.days} days`} />
      <Kpi label="Pageviews" value={kpis.pageviews} sub={`${perVisit} per visit`} />
      <Kpi label="Bounce" text={pct(kpis.bounceRate)} sub="left after one page" />
      <Kpi
        label="Visit length"
        text={visitLength(kpis.medianVisitSeconds)}
        sub={identified ? `${compact(kpis.signedIn)} signed in` : 'median'}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  text,
  sub,
}: {
  label: string;
  value?: number;
  text?: string;
  sub: string;
}): React.JSX.Element {
  return (
    <div className="card-pop flex flex-col gap-1 px-4 py-3">
      <span className="mono-label text-muted-foreground">{label}</span>
      {value !== undefined ? (
        <CountUp value={value} format={compact} className="font-display text-3xl font-bold" />
      ) : (
        <span className="font-display text-3xl font-bold">{text}</span>
      )}
      <span className="text-muted-foreground hidden text-xs sm:block">{sub}</span>
    </div>
  );
}
