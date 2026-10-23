import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { listWords } from './connections-model';
import { useConnections } from './use-connections';
import { AppPicker } from './app-picker';
import { InsideAppSection } from './inside-app-section';
import { ManagedDataSection } from './managed-data-section';
import { LinksAside } from './links-aside';

/**
 * Network › Connections (board 44): apps are isolated by default; this is
 * where one app's internal names live, which managed data stays private to
 * it, and which other apps it is connected to (`stacks.connect`, one private
 * network per pair). `app` is the `?app=` pick, else the first app.
 */
export function ConnectionsPage({ app }: { app?: string }): React.JSX.Element {
  const c = useConnections(app);
  const e = c.endpoints;
  const peers = e?.connectedApps ?? [];
  const lede = e
    ? `${e.stack} talks to ${peers.length === 0 ? 'no other app' : `${peers.length} other app${peers.length === 1 ? '' : 's'}: ${listWords(peers)}`}.` +
      (c.groups.length === 1 ? ' Its managed data stays private to it either way.' : c.groups.length ? ` Its ${c.groups.length} managed data services stay private to it either way.` : '')
    : undefined;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        title={
          <>
            Apps are isolated by default. <em>Other apps can’t reach an app’s services until you connect them.</em>
          </>
        }
        description={lede}
        actions={<AppPicker apps={c.apps} value={c.app} />}
      />
      {c.error && !c.ready ? (
        <ErrorState title={c.app ? `Couldn’t read ${c.app}’s names.` : undefined} error={c.error} retry={c.retry} />
      ) : !c.ready ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={3} />
        </div>
      ) : !e || !c.app ? (
        <Section title="No apps yet">
          <p className="text-muted-foreground text-[13.5px]">Once two apps run here, you can let one reach the other’s services.</p>
          <Button asChild className="w-fit">
            <Link to="/deploy">Deploy an app</Link>
          </Button>
        </Section>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-5">
            <InsideAppSection endpoints={e} />
            <ManagedDataSection endpoints={e} groups={c.groups} vars={c.vars} />
            <p className="text-muted-foreground px-1 font-mono text-[11.5px]">Platform services run on their own network.</p>
          </div>
          <LinksAside key={e.stack} endpoints={e} groups={c.groups} apps={c.apps} auditLine={c.auditLine} />
        </div>
      )}
    </div>
  );
}
