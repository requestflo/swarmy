import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import {
  PRIMARY,
  NAV_GROUPS,
  groupForPathname,
  type Destination,
  type NavGroup,
} from '@/lib/destinations';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { useNavBadges } from '@/lib/use-nav-badges';
import { TextSkeleton } from '@/components/states';
import { CreateMenu } from './create-menu';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';

/**
 * The desktop shell: a fixed navy sidenav (the Hot Signal statement surface).
 * Eight flat destinations, nothing collapsed: the 3 anchors (Overview / Stacks
 * / Infrastructure) then one row per section (Deploy / Platform / Operations /
 * Governance / Settings). A section's surfaces live as in-page tabs
 * (`SectionHeader`), so the nav never rearranges itself and attention badges
 * (offline nodes, firing alerts, open incidents) are always visible — rolled
 * up onto the section row they belong to.
 */
export function Sidenav(): React.JSX.Element {
  const { pathname } = useLocation();
  const activeTo = useActivePrimary(pathname);
  const activeGroup = React.useMemo(() => groupForPathname(pathname), [pathname]);
  const badges = useNavBadges();

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

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {PRIMARY.map((d) => (
          <NavRow
            key={d.to}
            to={d.to}
            label={d.label}
            icon={d.icon}
            active={activeTo === d.to}
            count={d.badge ? badges[d.badge] : 0}
          />
        ))}
        <div className="pt-3" />
        {NAV_GROUPS.map((g) => (
          <NavRow
            key={g.group}
            to={g.to}
            label={g.label}
            icon={g.icon}
            active={activeGroup === g.group}
            count={g.badges.reduce((n, key) => n + badges[key], 0)}
          />
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

/** Most-specific active anchor (so /nodes/new still lights Infrastructure). */
function useActivePrimary(pathname: string): string | null {
  return React.useMemo(() => {
    const matches = PRIMARY.filter((d) =>
      d.exact ? pathname === d.to : pathname === d.to || pathname.startsWith(`${d.to}/`),
    );
    return matches.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;
  }, [pathname]);
}

function NavRow({
  to,
  label,
  icon: Icon,
  active,
  count,
}: {
  to: string;
  label: string;
  icon: Destination['icon'] | NavGroup['icon'];
  active: boolean;
  count: number;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-ink-foreground text-ink font-semibold'
          : 'text-ink-foreground/75 hover:text-ink-foreground hover:bg-white/5',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span className="bg-primary text-primary-foreground flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold">
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

/** "N/M nodes online" — the same estate summary the Overview KPIs read, so they agree. */
function ClusterFooter(): React.JSX.Element {
  const estate = useEstateSummary();
  const nodes = estate.status === 'ready' ? estate.data.nodes : null;
  const allUp = !!nodes && nodes.total > 0 && nodes.online === nodes.total;
  return (
    <Link
      to="/nodes"
      className="text-ink-foreground/60 hover:text-ink-foreground flex items-center gap-2 px-3 py-1 text-xs transition-colors"
    >
      <span
        className={cn('size-2 rounded-full', nodes && nodes.total > 0 && 'pulse-dot')}
        style={{
          background: `var(--status-${!nodes ? 'idle' : allUp ? 'online' : nodes.online > 0 ? 'warning' : 'idle'})`,
        }}
      />
      {nodes ? (
        <>
          <span className="mono-data">
            {nodes.online}/{nodes.total}
          </span>
          <span>{nodes.total === 1 ? 'node online' : 'nodes online'}</span>
        </>
      ) : (
        <TextSkeleton className="w-24 bg-white/10" />
      )}
    </Link>
  );
}
