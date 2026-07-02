import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import {
  PRIMARY,
  SECTIONS,
  NAV_GROUP_ORDER,
  type Destination,
  type DestinationGroup,
} from '@/lib/destinations';
import { useNavBadges } from '@/lib/use-nav-badges';
import { CreateMenu } from './create-menu';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';

/**
 * The desktop shell: a fixed navy sidenav (the Hot Signal statement surface).
 * Three headerless anchors (Overview / Stacks / Infrastructure) sit above the
 * grouped, collapsible sections so all 40 destinations are discoverable at a
 * glance instead of buried in a dropdown. The group containing the current
 * route auto-expands; attention badges (offline nodes, firing alerts, open
 * incidents) surface where the work is.
 */
export function Sidenav(): React.JSX.Element {
  const { pathname } = useLocation();
  const activeTo = useActiveDestination(pathname);
  const activeGroup = React.useMemo<DestinationGroup | null>(
    () => SECTIONS.find((s) => s.to === activeTo)?.group ?? null,
    [activeTo],
  );

  return (
    <aside className="ink-block fixed inset-y-0 left-0 z-30 hidden w-64 flex-col lg:flex">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <Link to="/overview" className="flex items-center gap-2.5">
          <Wordmark className="text-ink-foreground" />
        </Link>
        <OrgName />
      </div>

      <div className="space-y-2 px-3 pb-2">
        <CreateMenu />
        <SearchButton />
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-2">
        <div className="space-y-0.5">
          {PRIMARY.map((d) => (
            <NavRow key={d.to} d={d} activeTo={activeTo} />
          ))}
        </div>
        {NAV_GROUP_ORDER.map((group) => (
          <NavGroup key={group} group={group} activeTo={activeTo} defaultOpen={group === activeGroup} />
        ))}
      </nav>

      <div className="border-t border-white/10 px-3 py-3">
        <ClusterFooter />
        <div className="mt-2">
          <UserMenu side="top" tone="ink" />
        </div>
      </div>
    </aside>
  );
}

/** Most-specific active destination wins (so /settings/access ≠ /settings). */
function useActiveDestination(pathname: string): string | null {
  return React.useMemo(() => {
    const all: Destination[] = [...PRIMARY, ...SECTIONS];
    const matches = all.filter((d) =>
      d.exact ? pathname === d.to : pathname === d.to || pathname.startsWith(`${d.to}/`),
    );
    return matches.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;
  }, [pathname]);
}

function NavGroup({
  group,
  activeTo,
  defaultOpen,
}: {
  group: DestinationGroup;
  activeTo: string | null;
  defaultOpen: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  // Re-open when navigation lands inside this group.
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const items = SECTIONS.filter((s) => s.group === group);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-ink-foreground/45 hover:text-ink-foreground/70 flex w-full items-center gap-1.5 px-3 py-1 text-[11px] font-semibold tracking-wider uppercase transition-colors"
      >
        <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {group}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {items.map((d) => (
            <NavRow key={d.to} d={d} activeTo={activeTo} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavRow({ d, activeTo }: { d: Destination; activeTo: string | null }): React.JSX.Element {
  const badges = useNavBadges();
  const active = activeTo === d.to;
  const count = d.badge ? badges[d.badge] : 0;
  return (
    <Link
      to={d.to}
      className={cn(
        'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-ink-foreground text-ink font-semibold'
          : 'text-ink-foreground/75 hover:text-ink-foreground hover:bg-white/5',
      )}
    >
      <d.icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{d.label}</span>
      {count > 0 && (
        <span
          className={cn(
            'flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold',
            active ? 'bg-primary text-primary-foreground' : 'bg-primary/90 text-primary-foreground',
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

function SearchButton(): React.JSX.Element {
  const { toggle } = useCommandPalette();
  return (
    <button
      onClick={toggle}
      className="text-ink-foreground/60 hover:text-ink-foreground flex w-full items-center gap-2 rounded-full bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 transition-colors hover:bg-white/10"
    >
      <SearchIcon className="size-4" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

function OrgName(): React.JSX.Element | null {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  if (!org.data?.name) return null;
  return (
    <span className="text-ink-foreground/50 truncate border-l border-white/15 pl-2.5 text-xs">
      {org.data.name}
    </span>
  );
}

function ClusterFooter(): React.JSX.Element {
  const trpc = useTRPC();
  const summary = useQuery({
    ...trpc.system.dashboardSummary.queryOptions(),
    refetchInterval: 5_000,
  });
  const online = summary.data?.nodes.online ?? 0;
  const total = summary.data?.nodes.total ?? 0;
  const allUp = total > 0 && online === total;
  return (
    <Link
      to="/nodes"
      className="text-ink-foreground/60 hover:text-ink-foreground flex items-center gap-2 px-3 py-1 text-xs transition-colors"
    >
      <span
        className={cn('size-2 rounded-full', total > 0 && 'pulse-dot')}
        style={{ background: `var(--status-${allUp ? 'online' : online > 0 ? 'warning' : 'idle'})` }}
      />
      <span className="mono-data">
        {online}/{total}
      </span>
      <span>{total === 1 ? 'node online' : 'nodes online'}</span>
    </Link>
  );
}
