import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { NodeSummary } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { AlreadyOn, CalmPage, Depth, SayHeader } from '@/components/calm';
import { useCommandPalette } from '@/components/shell/command-palette-provider';
import { DepthWelcomeCard } from './depth-welcome-card';
import { estateAlreadyOn } from './estate-already-on';
import { OverviewCode } from './overview-code';
import type { SetupFacts } from './use-setup-facts';
import { WelcomePicture } from './welcome-picture';
import { WelcomeServerCard, dashboardOnHttps } from './welcome-server-card';
import { WelcomeSteps } from './welcome-steps';
import type { ServerGlance } from './use-servers-glance';

const today = (): string => new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The first-run Overview (canvas "Main" + RWelcome). No servers yet: add one.
 * A server but nothing deployed: "Your cloud is up." with the first deploy as
 * the one coral action and ⌘K as the quiet second; the steps, what's already
 * on, then the pick-your-depth card. On lg+ the right side is the server in
 * its region; below that, just the server card under the steps.
 */
export function WelcomeEstate({
  servers,
  nodes,
  setup,
  channels,
}: {
  servers: ServerGlance[];
  nodes: NodeSummary[];
  setup: SetupFacts;
  channels: number;
}): React.JSX.Element {
  const palette = useCommandPalette();
  const none = servers.length === 0;
  const first = servers[0];
  const place = first?.node.region ? ` in ${first.node.region}` : '';
  const dashboardHere = servers.length === 1 && dashboardOnHttps();
  const on = setup.ready ? estateAlreadyOn(setup, { channels, servers: servers.length }) : [];
  return (
    <CalmPage
      crumbs={[{ label: 'Overview' }]}
      className="xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]"
      aside={
        <>
          <Depth at="code">
            <OverviewCode apps={[]} nodes={nodes} />
          </Depth>
          {first ? (
            <div className="hidden lg:block">
              <WelcomePicture server={first} dashboardHere={dashboardHere} />
            </div>
          ) : null}
        </>
      }
    >
      <SayHeader
        eyebrow={none ? 'Welcome' : `${servers.length === 1 ? 'One server' : `${servers.length} servers`} ready · ${today()}`}
        title={none ? <>Let’s get your cloud <em>up.</em></> : <>Your cloud is up.</>}
        lede={
          none
            ? 'Add a server: any machine with Docker, rented or at home. Paste one line on it and it joins privately. Then deploy an app.'
            : `${servers.length === 1 ? `One server${place}` : `${servers.length} servers`}, ready for apps. Deploy something and it gets a web address with HTTPS, backups and alerts, without you setting any of it up.`
        }
        actions={
          <>
            <Button asChild size="lg" className="pointer-coarse:min-h-11">
              <Link to={none ? '/nodes/new' : '/deploy'}>{none ? 'Add your first server' : 'Deploy your first app'}</Link>
            </Button>
            <Button variant="outline" size="lg" onClick={() => palette.setOpen(true)} className="gap-2 pointer-coarse:min-h-11">
              <kbd className="border-border bg-muted rounded border px-1.5 font-mono text-[11px]">⌘K</kbd>
              or just ask
            </Button>
          </>
        }
      />
      <WelcomeSteps hasServer={!none} hasDomain={setup.domainCount > 0} hasSecondServer={servers.length >= 2} />
      {first ? <WelcomeServerCard server={first} dashboardHere={dashboardHere} className="lg:hidden" /> : null}
      {on.length ? (
        <section aria-labelledby="welcome-on-h" className="flex flex-col gap-2.5">
          <h2 id="welcome-on-h" className="calm-eyebrow">Already on</h2>
          <AlreadyOn items={on} bare />
        </section>
      ) : null}
      <DepthWelcomeCard />
    </CalmPage>
  );
}
