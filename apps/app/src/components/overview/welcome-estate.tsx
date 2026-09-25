import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { NodeSummary } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, SayHeader } from '@/components/calm';
import { DepthWelcomeCard } from './depth-welcome-card';
import { OverviewCode } from './overview-code';
import { WelcomeServerCard } from './welcome-server-card';
import { WelcomeSteps } from './welcome-steps';
import type { ServerGlance } from './use-servers-glance';

/**
 * The first-run Overview (canvas "Main" + RWelcome). No servers yet: add one.
 * A server but nothing deployed: "Your cloud is up." with the first deploy as
 * the one coral action, and the pick-your-depth card until they've chosen.
 */
export function WelcomeEstate({ servers, nodes }: { servers: ServerGlance[]; nodes: NodeSummary[] }): React.JSX.Element {
  const none = servers.length === 0;
  const first = servers[0];
  const place = first?.node.region ? ` in ${first.node.region}` : '';
  return (
    <CalmPage
      crumbs={[{ label: 'Overview' }]}
      aside={
        <>
          <Depth at="code">
            <OverviewCode apps={[]} nodes={nodes} />
          </Depth>
          {first ? <WelcomeServerCard server={first} /> : null}
        </>
      }
    >
      <SayHeader
        eyebrow={none ? 'Welcome' : `${servers.length === 1 ? 'One server' : `${servers.length} servers`} ready`}
        title={none ? <>Let’s get your cloud <em>up.</em></> : <>Your cloud is up.</>}
        lede={
          none
            ? 'Add a server: any machine with Docker, rented or at home. Paste one line on it and it joins privately. Then deploy an app.'
            : `${servers.length === 1 ? `One server${place}` : `${servers.length} servers`}, ready for apps. Anything you deploy gets a web address with HTTPS, nightly backups and alerts, without you setting them up.`
        }
        actions={
          <Button asChild size="lg">
            <Link to={none ? '/nodes/new' : '/deploy'}>{none ? 'Add your first server' : 'Deploy your first app'}</Link>
          </Button>
        }
      />
      <WelcomeSteps hasServer={!none} />
      <DepthWelcomeCard />
    </CalmPage>
  );
}
