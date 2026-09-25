import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { Depth, SayHeader, useDepth } from '@/components/calm';
import { RumCode } from './rum-code';
import { CardSkeleton, ErrorState } from '@/components/states';
import { AnalyticsConsentWarning } from './analytics-consent-warning';
import { AnalyticsKpis } from './analytics-kpis';
import { AnalyticsModeBar } from './analytics-mode-bar';
import { BreakdownList } from './breakdown-list';
import { ObsSubTabs } from './obs-sub-tabs';
import { compact, countryName, pct } from './rum-shared';
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
  const wide = useDepth().atLeast('controls');
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
      <div className="flex flex-col gap-5 pb-8">
        <SayHeader size="md" title="Couldn’t read this app’s analytics." />
        {tabs}
        <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />
      </div>
    );
  }
  const d = q.data;
  const off = s ? !s.enabled : false;
  const notice =
    d.status === 'disabled' ? 'analytics-disabled' : d.status === 'unreachable' ? 'unreachable' : off && d.kpis.visits === 0 ? 'off' : null;

  const k = d.kpis;
  const title = notice
    ? <>Analytics is off for {stack}.</>
    : k.visits === 0
      ? <>No visitors counted in the last {days} days. <em>It’s on and waiting.</em></>
      : <>{compact(k.visits)} visits to {host ?? stack} in the last {days} days. <em>{compact(d.live.visitors)} people here right now.</em></>;
  const lede = notice
    ? 'Turn it on and the edge counts every page view. No script to add, no cookies in privacy mode.'
    : `${compact(k.pageviews)} page views, ${pct(k.bounceRate)} left after one page. Counted at the edge${identified ? ', with signed-in visitors' : ', cookieless: no personal data'}.`;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <SayHeader size="md" title={title} lede={lede} />
      {tabs}
      {s ? <RumCode stack={stack} settings={s} routes={settings.data?.routes ?? []} /> : null}
      <Depth at="controls">
        <AnalyticsModeBar stack={stack} identified={identified} days={days} onDays={setDays} />
      </Depth>
      {identified && s?.consent === 'none' ? <AnalyticsConsentWarning stack={stack} /> : null}
      {notice ? (
        <RumStateNotice stack={stack} kind={notice} />
      ) : (
        <>
          <div className={wide ? 'grid gap-3 xl:grid-cols-[3fr_2fr]' : 'grid gap-3'}>
            <AnalyticsKpis data={d} identified={identified} />
            <Depth at="controls">
              <VisitorsChart series={d.series} />
            </Depth>
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
          <Depth at="controls">
            <div className="grid gap-3 lg:grid-cols-3">
              <BreakdownList title="Devices" rows={d.devices} emptyKey="Unknown" limit={5} />
              <BreakdownList title="Browsers" rows={d.browsers} emptyKey="Unknown" limit={6} />
              {identified ? (
                <SignedInVisitors stack={stack} users={d.users} />
              ) : (
                <BreakdownList title="Sources" caption="utm_source" rows={d.sources} emptyKey="None" limit={6} />
              )}
            </div>
          </Depth>
        </>
      )}
    </div>
  );
}
