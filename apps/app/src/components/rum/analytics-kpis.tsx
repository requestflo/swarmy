import * as React from 'react';
import { cn } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';
import { signedPct, signedPts, versus, type KpiDelta } from './analytics-delta';
import { compact, pct, visitLength, type AnalyticsView } from './rum-shared';

interface AnalyticsKpisProps {
  data: AnalyticsView;
  identified: boolean;
  /** Against the previous window of the same length; null when it can't be read. */
  delta: KpiDelta | null;
}

/**
 * Visitors · pageviews · bounce · visit length, plus the live count (refreshed
 * every 15 s). Visitors and bounce say how they moved since the window before.
 */
export function AnalyticsKpis({ data, identified, delta }: AnalyticsKpisProps): React.JSX.Element {
  const { kpis, live } = data;
  const perVisit = kpis.visits ? (kpis.pageviews / kpis.visits).toFixed(1) : '0';
  const views = delta?.pageviews != null ? ` · ${signedPct(delta.pageviews)}` : '';
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <div className="ink-block flex flex-col gap-1 rounded-2xl px-4 py-3">
        <span className="mono-label text-ink-foreground flex items-center gap-2">
          <span className="pulse-dot" aria-hidden /> Live now
        </span>
        <CountUp value={live.visitors} className="font-display text-3xl font-bold" />
        <span className="hidden text-xs opacity-75 sm:block">
          visitors in the last 5 min · {compact(live.pageviews)} views
        </span>
      </div>
      <Kpi
        label="Visitors"
        value={kpis.visits}
        sub={delta ? `${signedPct(delta.visits)} ${versus(data.days)}` : `last ${data.days} days`}
        good={delta ? Math.round(delta.visits * 100) > 0 : false}
      />
      <Kpi label="Pageviews" value={kpis.pageviews} sub={`${perVisit} per visit${views}`} />
      <Kpi
        label="Bounce"
        text={pct(kpis.bounceRate)}
        sub={delta ? `${signedPts(delta.bouncePts)} · left after one page` : 'left after one page'}
        good={delta ? Math.round(delta.bouncePts) < 0 : false}
      />
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
  good = false,
}: {
  label: string;
  value?: number;
  text?: string;
  sub: string;
  /** The delta moved the right way — say it in the healthy colour. */
  good?: boolean;
}): React.JSX.Element {
  return (
    <div className="calm-card shadow-none flex flex-col gap-1 px-4 py-3">
      <span className="mono-label text-muted-foreground">{label}</span>
      {value !== undefined ? (
        <CountUp value={value} format={compact} className="font-display text-3xl font-bold" />
      ) : (
        <span className="font-display text-3xl font-bold">{text}</span>
      )}
      <span className={cn('hidden text-xs sm:block', good ? 'text-tone-ok' : 'text-muted-foreground')}>{sub}</span>
    </div>
  );
}
