import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CalmPage, Depth, Section, SectionLink } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { AppRows } from '@/components/apps/app-rows';
import { estateSay } from '@/components/apps/estate-say';
import { useApps } from '@/components/apps/use-apps';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { DepthWelcomeCard } from './depth-welcome-card';
import { EstateAlreadyOn, estateAlreadyOn } from './estate-already-on';
import { OverviewCode } from './overview-code';
import { OverviewHeader, overviewLede } from './overview-header';
import { OverviewNext, pickNext } from './overview-next';
import { ServersSection } from './servers-section';
import { TodayFeed } from './today-feed';
import { todayItems } from './today-items';
import { useOverviewSignals } from './use-overview-signals';
import { useServersGlance } from './use-servers-glance';
import { useSetupFacts } from './use-setup-facts';
import { WelcomeEstate } from './welcome-estate';
import { WorthDoingNext, setupSteps } from './worth-doing-next';

/**
 * Overview (RHome): the estate as a sentence, the one thing that needs you,
 * your apps as calm rows, the servers in a line, and today's changes. The
 * aside holds what's already on and what's worth doing next; Code adds the
 * CLI/REST view on top of it. Nothing paints until the numbers settle.
 */
export function OverviewPage(): React.JSX.Element {
  const estate = useEstateSummary();
  const a = useApps();
  const sig = useOverviewSignals();
  const fleet = useServersGlance();
  const setup = useSetupFacts();

  if (estate.status === 'error' || a.error) {
    return <PageError title="Couldn’t reach your estate." error={estate.error ?? a.error} retry={estate.refetch} retrying={estate.isFetching} />;
  }
  if (estate.status === 'pending' || a.pending || fleet.pending || !sig.ready) return <PageSkeleton variant="kpis" />;

  const e = estate.data;
  if (e.nodes.total === 0 || a.apps.length === 0) return <WelcomeEstate servers={fleet.servers} nodes={fleet.nodes} setup={setup} channels={e.alerts.channels} />;

  const say = estateSay({
    apps: a.apps,
    alertsFiring: e.alerts.firing,
    incidentsOpen: e.incidents.open,
    nodesOnline: e.nodes.online,
    nodesTotal: e.nodes.total,
  });
  const feed = todayItems(sig.releases, sig.audit);
  const lastBackup = feed.items.find((i) => i.id.startsWith('audit-'))?.at ?? null;
  const next = pickNext(sig.openIncidents, sig.firing, a.apps, fleet.nodes);
  const x = { apps: a.apps.length, servers: e.nodes.total, channels: e.alerts.channels };

  return (
    <CalmPage
      crumbs={[{ label: 'Overview' }]}
      aside={
        <>
          <Depth at="code">
            <OverviewCode apps={a.apps} nodes={fleet.nodes} />
          </Depth>
          {setup.ready ? (
            <>
              <EstateAlreadyOn items={estateAlreadyOn(setup, x)} />
              <WorthDoingNext steps={setupSteps(setup, x)} />
            </>
          ) : null}
        </>
      }
    >
      <OverviewHeader say={say} lede={overviewLede(e, sig.releases[0]?.createdAt ?? null, lastBackup)} />
      <DepthWelcomeCard />
      {next ? <OverviewNext next={next} /> : null}
      <Section
        title="Your apps"
        count={a.apps.length}
        flush
        action={
          <Link to="/" className="pointer-coarse:py-3">
            <SectionLink>All apps →</SectionLink>
          </Link>
        }
      >
        <AppRows apps={a.apps} />
      </Section>
      <ServersSection servers={fleet.servers} />
      <TodayFeed items={feed.items} today={feed.today} />
    </CalmPage>
  );
}
