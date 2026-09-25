import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, CodeView, Say, SayHeader, Section, useDepth } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { ApplicationsCanvas } from '@/components/canvas/applications-canvas';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { AppRows } from './app-rows';
import { AppsViewToggle, useAppsView } from './apps-view-toggle';
import { appsSay } from './estate-say';
import { stacksRest } from './estate-code';
import { plural } from './app-words';
import { useApps } from './use-apps';

/**
 * Apps: every app as one calm row, with the estate map as a view toggle
 * (List | Map, remembered). One coral action: deploy an app.
 */
export function AppsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const a = useApps();
  const estate = useEstateSummary();
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const [view, setView] = useAppsView();
  const code = useDepth().atLeast('code');

  if (a.error) return <PageError title="Couldn’t read your apps." error={a.error} retry={a.refetch} />;
  if (a.pending || estate.status === 'pending') return <PageSkeleton variant="list" />;

  const e = estate.data;
  const say = appsSay({
    apps: a.apps,
    alertsFiring: e?.alerts.firing ?? 0,
    incidentsOpen: e?.incidents.open ?? 0,
    nodesOnline: e?.nodes.online ?? 0,
    nodesTotal: e?.nodes.total ?? 0,
  });
  const parts = a.apps.reduce((n, x) => n + x.stat.serviceCount, 0);
  const deploy = (
    <Button asChild>
      <Link to="/deploy">Deploy an app</Link>
    </Button>
  );

  return (
    <CalmPage
      crumbs={[{ label: 'Apps' }]}
      wide
      aside={code ? <CodeView tabs={[{ label: 'REST', code: stacksRest(stacks.data ?? []) }]} source="dashboard" /> : undefined}
    >
      <SayHeader
        title={
          a.apps.length === 0 ? (
            <>Nothing deployed yet. <em>Your first app takes about two minutes.</em></>
          ) : (
            <>
              {say.lead} {say.clause ? <Say tone={say.clause.tone}>{say.clause.text}</Say> : null}
            </>
          )
        }
        lede={
          a.apps.length === 0
            ? 'Pick a template or bring your own compose file, image or git repo. It gets an address with HTTPS and a nightly backup.'
            : `${plural(parts, 'part')} across ${plural(a.apps.length, 'app')}. Open one to see how it is built.`
        }
        actions={deploy}
      />
      {a.apps.length > 0 ? (
        <Section
          title="Your apps"
          count={a.apps.length}
          flush={view === 'list'}
          action={<AppsViewToggle view={view} onChange={setView} />}
        >
          {view === 'list' ? <AppRows apps={a.apps} /> : <ApplicationsCanvas />}
        </Section>
      ) : null}
      {view === 'list' && a.platform.length > 0 ? (
        <Section title="Platform" hint="swarmy’s own parts, kept running for you" flush>
          <AppRows apps={a.platform} label="Platform" />
        </Section>
      ) : null}
    </CalmPage>
  );
}
