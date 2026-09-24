import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, ErrorState } from '@/components/states';
import { AnalyticsConsentWarning } from './analytics-consent-warning';
import { AnalyticsKpis } from './analytics-kpis';
import { AnalyticsModeBar } from './analytics-mode-bar';
import { BreakdownList } from './breakdown-list';
import { ObsSubTabs } from './obs-sub-tabs';
import { countryName } from './rum-shared';
import { RumStateNotice } from './rum-state-notice';
import { SignedInVisitors } from './signed-in-visitors';
import { useRumSettings } from './use-rum';
import { VisitorsChart } from './visitors-chart';

/**
 * Web analytics for one app: counted at the edge, no script to add. KPIs and
 * the live count up top, visitors per day, then where people went, came from
 * and browsed with — and, in identified mode, who they were.
 */
export function AnalyticsPage({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [days, setDays] = React.useState(7);
  const settings = useRumSettings(stack);
  const q = useQuery({ ...trpc.rum.analytics.queryOptions({ stack, days }), refetchInterval: 15_000 });
  const s = settings.data?.settings;
  const identified = s?.mode === 'identified';
  const host = settings.data?.routes[0]?.host;

  const tabs = (
    <ObsSubTabs
      stack={stack}
      active="analytics"
      aside={host ? `${host} · counted at the edge, no script to add` : 'counted at the edge, no script to add'}
    />
  );
  if (q.isPending || settings.isPending) {
    return (
      <div className="space-y-3 pb-8">
        {tabs}
        <CardSkeleton lines={1} />
        <div className="grid gap-3 lg:grid-cols-3">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="pb-8">
        {tabs}
        <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  const d = q.data;
  const off = s ? !s.enabled : false;
  const notice =
    d.status === 'disabled' ? 'analytics-disabled' : d.status === 'unreachable' ? 'unreachable' : off && d.kpis.visits === 0 ? 'off' : null;

  return (
    <div className="space-y-3 pb-8">
      {tabs}
      <AnalyticsModeBar stack={stack} identified={identified} days={days} onDays={setDays} />
      {identified && s?.consent === 'none' ? <AnalyticsConsentWarning stack={stack} /> : null}
      {notice ? (
        <RumStateNotice stack={stack} kind={notice} />
      ) : (
        <>
          {d.kpis.visits === 0 ? (
            <p className="text-muted-foreground card-pop px-5 py-4 text-sm">
              On and waiting — nothing counted in the last {days} days yet. Numbers appear with the next page view.
            </p>
          ) : null}
          <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
            <AnalyticsKpis data={d} identified={identified} />
            <VisitorsChart series={d.series} />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <BreakdownList title="Top pages" rows={d.pages} mono showVisitors={identified} emptyKey="/" />
            <BreakdownList title="Referrers" rows={d.referrers} emptyKey="Direct" />
            <BreakdownList
              title="Countries"
              caption="own GeoIP · no IPs stored"
              rows={d.countries}
              emptyKey="Unknown"
              format={countryName}
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <BreakdownList title="Devices" rows={d.devices} emptyKey="Unknown" limit={5} />
            <BreakdownList title="Browsers" rows={d.browsers} emptyKey="Unknown" limit={6} />
            {identified ? (
              <SignedInVisitors stack={stack} users={d.users} />
            ) : (
              <BreakdownList title="Sources" caption="utm_source" rows={d.sources} emptyKey="None" limit={6} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
