import * as React from 'react';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, NextAction } from '@/components/calm';
import { PageError, PageSkeleton } from '@/components/states';
import { MeshDriverCard } from './mesh-driver-card';
import { EnrollNodeCard } from './enroll-node-card';
import { ControlPlaneCard } from './control-plane-card';
import { PeopleAccessCard } from './people-access-card';
import { PeopleRows, ServerRows } from './private-network-rows';
import { PrivateNetworkCode } from './private-network-code';
import { usePrivateNetwork } from './use-private-network';

const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;

/** /networking — "Private network": servers and laptops on one encrypted network, no open ports. */
export function PrivateNetworkPage(): React.JSX.Element {
  const n = usePrivateNetwork();
  if (n.error && !n.ready) return <Pad><PageError error={n.error} retry={n.retry} /></Pad>;
  if (!n.ready) return <PageSkeleton variant="list" />;

  const servers = n.peers.length;
  const title = n.live ? (
    <>
      {plural(servers, 'server')}
      {n.laptops.length ? ` and ${plural(n.laptops.length, 'laptop')}` : ''} on your private network. <em>No open ports.</em>
    </>
  ) : (
    <>Your servers talk over your own network. <em>The private network is off.</em></>
  );
  const next = n.live ? n.missing[0] : undefined;

  return (
    <Pad>
      <SectionHeader
        title={title}
        description={
          n.live
            ? 'Servers in any cloud or behind any router reach each other directly, encrypted. Databases and admin pages never face the internet; people reach them from their laptop.'
            : 'Turn it on to join servers anywhere into one encrypted network, with nothing exposed to the internet.'
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {!n.live && n.driver !== 'none' ? (
            <NextAction
              title="Turn on the private network"
              actions={<Button onClick={() => n.setEnabled.mutate({ enabled: true })} disabled={n.setEnabled.isPending}>Turn it on</Button>}
            >
              Every server joins on its own. Nothing changes for apps that are already running.
            </NextAction>
          ) : null}
          {next ? (
            <NextAction
              title={`${next.name} isn't on the private network`}
              tech={`mesh.enrollNode · ${next.id}`}
              actions={
                <Button onClick={() => n.enrollNode.mutate({ nodeId: next.id })} disabled={n.enrollNode.isPending}>
                  Add {next.name}
                </Button>
              }
            >
              Adding it opens no ports. It dials out, swaps keys, and finds the shortest path to the others.
            </NextAction>
          ) : null}
          {n.live ? <ServerRows n={n} /> : null}
          <Depth at="controls">
            <div className="grid gap-4 lg:grid-cols-2">
              <MeshDriverCard
                driver={n.driver}
                enabled={!!n.config?.enabled}
                isNone={n.driver === 'none'}
                onDriverChange={(d) => n.setDriver.mutate({ driver: d })}
                onEnabledChange={(v) => n.setEnabled.mutate({ enabled: v })}
              />
              <EnrollNodeCard
                active={n.live}
                nodes={n.nodes}
                enrollNodeId={n.enrollNodeId}
                onEnrollNodeIdChange={n.setEnrollNodeId}
                onEnroll={(nodeId) => n.enrollNode.mutate({ nodeId })}
                isPending={n.enrollNode.isPending}
              />
            </div>
            {n.driver !== 'none' ? <ControlPlaneCard driver={n.driver} /> : null}
            {n.managed ? <PeopleAccessCard /> : null}
          </Depth>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <PrivateNetworkCode n={n} />
          {n.managed ? <PeopleRows n={n} /> : null}
          {n.live ? (
            <AlreadyOn
              items={[
                { what: 'Encrypted', detail: 'every link, end to end' },
                { what: 'No open ports', detail: 'servers dial out, nothing listens' },
                ...(n.managed ? [{ what: 'Laptops', detail: 'sign in with swarmy; nothing else is reachable' }] : []),
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
