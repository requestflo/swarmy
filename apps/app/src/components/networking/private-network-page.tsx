import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { AlreadyOn, Depth, NextAction, Say, Section } from '@/components/calm';
import { useMedia } from '@/components/estate-map/use-media';
import { PageError, PageSkeleton } from '@/components/states';
import { ServerRows } from './private-network-rows';
import { PrivateNetworkCode } from './private-network-code';
import { MeshGraph } from './mesh-graph';
import { JOINING_STATUSES } from './mesh-graph-model';
import { MeshJoiningCard } from './mesh-joining-card';
import { MeshFacts } from './mesh-facts';
import { MeshLinksSection } from './mesh-links-section';
import { useMeshLinks } from './use-mesh-links';
import { useNatNodes } from './use-nat-nodes';
import { usePrivateNetwork } from './use-private-network';

const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;

/** /networking — the private network as a map (board 14): who's on it, how they link, who's joining. */
export function PrivateNetworkPage(): React.JSX.Element {
  const n = usePrivateNetwork();
  const nat = useNatNodes(n.peers.map((p) => p.nodeId));
  const links = useMeshLinks(n.live);
  const wide = useMedia('(min-width: 640px)');
  const names = React.useMemo(() => new Map(n.nodes.map((x) => [x.id, x.name])), [n.nodes]);
  if (n.error && !n.ready) return <Pad><PageError error={n.error} retry={n.retry} /></Pad>;
  if (!n.ready) return <PageSkeleton variant="list" />;

  const connected = n.peers.filter((p) => p.status === 'CONNECTED').length;
  const joining = n.peers.filter((p) => JOINING_STATUSES.has(p.status)).length;
  const stuck = n.peers.find((p) => p.status === 'FAILED' || p.status === 'DEGRADED');
  const title = n.live ? (
    <>
      {plural(connected, 'server')}
      {n.laptops.length ? ` and ${plural(n.laptops.length, 'laptop')}` : ''} on your private network
      {joining ? `, ${joining} joining` : ''}.{' '}
      {stuck ? <Say tone="warn">{names.get(stuck.nodeId) ?? stuck.nodeId} can&apos;t connect.</Say> : <em>No open ports.</em>}
    </>
  ) : (
    <>Your servers talk over your own network. <em>The private network is off.</em></>
  );
  const next = n.live ? n.missing[0] : undefined;
  const showMap = n.live && n.peers.length > 0 && wide;

  return (
    <Pad>
      <SectionHeader
        title={title}
        description={
          n.live
            ? `Private and encrypted${n.managed ? ', managed by swarmy' : ''}. Servers in any cloud or behind any router reach each other directly; databases and admin pages never face the internet.`
            : 'Turn it on to join servers anywhere into one encrypted network, with nothing exposed to the internet.'
        }
        actions={
          <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Link to="/networking/settings">Mesh settings</Link>
          </Button>
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
          {showMap ? (
            <Section title="Who talks to whom" count={plural(n.peers.length, 'server')} hint="each opens its server">
              <MeshGraph peers={n.peers} names={names} nat={nat} links={links} />
            </Section>
          ) : null}
          {n.live ? <Depth at="controls"><MeshLinksSection peers={n.peers} names={names} links={links} /></Depth> : null}
          {n.live ? showMap ? <Depth at="controls"><ServerRows n={n} /></Depth> : <ServerRows n={n} /> : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <PrivateNetworkCode n={n} links={links} />
          {n.live ? <MeshJoiningCard peers={n.peers} nodes={n.nodes} /> : null}
          {n.live ? <MeshFacts peers={n.peers} config={n.config} links={links} /> : null}
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
