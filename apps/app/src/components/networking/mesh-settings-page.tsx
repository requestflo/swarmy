import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ControlPlaneCard } from './control-plane-card';
import { DirectConnectSection } from './direct-connect-section';
import { EnrollNodeCard } from './enroll-node-card';
import { MeshAccessRulesSection } from './mesh-access-rules-section';
import { MeshDriverPick } from './mesh-driver-pick';
import { MeshMtuCard } from './mesh-mtu-card';
import { MeshPeersSection } from './mesh-peers-section';
import { PeopleAccessCard } from './people-access-card';
import { PrivateNetworkCode } from './private-network-code';
import { useNatNodes } from './use-nat-nodes';
import { usePrivateNetwork } from './use-private-network';

const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;

/** /networking/settings — Mesh settings (board 43): the driver, every peer, and who has laptop access. */
export function MeshSettingsPage(): React.JSX.Element {
  const n = usePrivateNetwork();
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const isAdmin = org.data?.role === 'owner' || org.data?.role === 'admin';
  const nat = useNatNodes(n.peers.map((p) => p.nodeId));
  if (n.error && !n.ready) return <Pad><PageError error={n.error} retry={n.retry} /></Pad>;
  if (!n.ready) return <PageSkeleton variant="list" />;

  const natNames = n.peers.filter((p) => nat.has(p.nodeId)).map((p) => n.nodes.find((x) => x.id === p.nodeId)?.name ?? p.nodeId);
  const title = n.live ? (
    <>
      {plural(n.peers.length, 'server')} on the private network. <em>{n.managed ? 'Managed by swarmy.' : 'Your own control server.'}</em>
    </>
  ) : (
    <>The private network is off. <em>Servers use their own network.</em></>
  );

  return (
    <Pad>
      <SectionHeader
        title={title}
        description="How servers reach each other, every peer and when it was last heard from, and who can reach a service from their laptop."
        actions={
          <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Link to="/networking">Back to the map</Link>
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {n.live ? <MeshMtuCard /> : null}
          <MeshDriverPick n={n} isAdmin={isAdmin} natNames={natNames} />
          {n.live ? <MeshPeersSection n={n} nat={nat} /> : null}
          {n.live ? <MeshAccessRulesSection isAdmin={isAdmin} /> : null}
          {n.live ? <DirectConnectSection isAdmin={isAdmin} /> : null}
          <Depth at="controls">
            <div className="grid gap-4 lg:grid-cols-2">
              {n.driver !== 'none' ? <ControlPlaneCard driver={n.driver} /> : null}
              <EnrollNodeCard
                active={n.live}
                nodes={n.nodes}
                enrollNodeId={n.enrollNodeId}
                onEnrollNodeIdChange={n.setEnrollNodeId}
                onEnroll={(nodeId) => n.enrollNode.mutate({ nodeId })}
                isPending={n.enrollNode.isPending}
              />
            </div>
            {n.managed ? <PeopleAccessCard /> : null}
          </Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <PrivateNetworkCode n={n} />
          {n.live ? (
            <AlreadyOn
              items={[
                { what: 'Encrypted', detail: 'every link, end to end, relayed or not' },
                { what: 'No inbound ports', detail: 'servers and laptops dial out' },
                { what: 'New servers', detail: 'join on their own from Add a server', to: '/nodes/new' },
                { what: 'Revoking', detail: 'cuts a laptop off within seconds' },
              ]}
            />
          ) : null}
        </aside>
      </div>
    </Pad>
  );
}

function Pad({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">{children}</div>;
}
