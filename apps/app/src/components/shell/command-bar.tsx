import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon, RocketIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import { PlaneTabs } from './plane-tabs';
import { SectionsMenu } from './sections-menu';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';

/**
 * The floating command bar — the entire desktop chrome (there is no sidenav).
 * Left: wordmark + org + a live cluster pulse. Center: the two plane tabs.
 * Right: ⌘K search, the sections overflow, one coral Deploy CTA, the user menu.
 */
export function CommandBar(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { toggle } = useCommandPalette();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const summary = useQuery({ ...trpc.system.dashboardSummary.queryOptions(), refetchInterval: 5_000 });
  const online = summary.data?.nodes.online ?? 0;
  const total = summary.data?.nodes.total ?? 0;

  return (
    <header className="sticky top-0 z-30 hidden px-4 pt-4 lg:block">
      <div className="card-pop mx-auto flex w-full max-w-[1800px] items-center gap-4 rounded-2xl px-4 py-2.5">
        <Link to="/" className="flex items-center gap-2.5">
          <Wordmark />
          {org.data?.name && (
            <span className="text-muted-foreground border-border hidden truncate border-l pl-2.5 text-sm xl:inline">
              {org.data.name}
            </span>
          )}
        </Link>

        <ClusterPulse online={online} total={total} />

        <div className="flex flex-1 justify-center">
          <PlaneTabs />
        </div>

        <button
          onClick={toggle}
          className="text-muted-foreground bg-muted/60 ring-border hover:bg-muted hidden h-9 w-56 items-center gap-2 rounded-full px-3 text-sm ring-1 transition-colors md:flex"
        >
          <SearchIcon className="size-4" />
          <span className="flex-1 text-left">Search or jump…</span>
          <kbd className="bg-background text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </button>

        <button onClick={toggle} className="text-muted-foreground hover:text-foreground md:hidden" aria-label="Search">
          <SearchIcon className="size-5" />
        </button>

        <SectionsMenu />

        <Button onClick={() => navigate({ to: '/services/new' })} className="gap-2">
          <RocketIcon className="size-4" /> Deploy
        </Button>

        <UserMenu />
      </div>
    </header>
  );
}

function ClusterPulse({ online, total }: { online: number; total: number }): React.JSX.Element {
  const allUp = total > 0 && online === total;
  return (
    <div className="text-muted-foreground hidden items-center gap-1.5 text-xs xl:flex">
      <span
        className={cn('size-2 rounded-full', total > 0 && 'pulse-dot')}
        style={{ background: `var(--status-${allUp ? 'online' : online > 0 ? 'warning' : 'idle'})` }}
      />
      <span className="mono-data">
        {online}/{total}
      </span>
    </div>
  );
}
