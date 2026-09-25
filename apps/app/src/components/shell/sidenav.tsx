import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, SearchIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import { NAV_GROUPS, navRowForPathname, type NavGroup } from '@/lib/destinations';
import { useEstateSummary } from '@/lib/use-estate-summary';
import { useNavBadges } from '@/lib/use-nav-badges';
import { TextSkeleton } from '@/components/states';
import { DepthDial } from '@/components/calm/depth-dial';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';

/**
 * The desktop shell (Calm Layers): the workspace, the coral "Deploy an app",
 * "Ask or jump… ⌘K", seven flat rows (Overview · Apps · Servers · Network ·
 * Data │ Activity · Settings), the "Show me" depth dial and the user row. A
 * row's pages are in-page tabs, so the nav never rearranges itself, and
 * attention badges roll up onto the row they belong to.
 */
export function Sidenav(): React.JSX.Element {
  const { pathname } = useLocation();
  const activeRow = React.useMemo(() => navRowForPathname(pathname), [pathname]);
  const badges = useNavBadges();

  return (
    <aside
      aria-label="Main"
      className="bg-nav text-nav-foreground fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-3 border-r border-[var(--nav-line)] px-2.5 pt-4 pb-3 lg:flex"
    >
      <Link
        to="/overview"
        className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 outline-none hover:bg-[var(--nav-hover)] focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <Wordmark className="text-nav-foreground" />
        <OrgName />
      </Link>

      <Link
        to="/deploy"
        className="bg-primary text-primary-foreground hover:bg-primary/90 flex h-10 items-center justify-center gap-2 rounded-[11px] text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <PlusIcon aria-hidden className="size-4" strokeWidth={2.6} />
        Deploy an app
      </Link>
      <SearchButton />

      <nav aria-label="Sections" className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {NAV_GROUPS.map((g) => (
          <React.Fragment key={g.group}>
            {g.divider ? <div aria-hidden className="mx-1.5 my-2 h-px bg-[var(--nav-line)]" /> : null}
            <NavRow
              to={g.to}
              label={g.label}
              icon={g.icon}
              active={activeRow === g.group}
              count={g.badges.reduce((n, key) => n + badges[key], 0)}
            />
          </React.Fragment>
        ))}
      </nav>

      <ClusterFooter />
      <DepthDial />
      <UserMenu side="top" tone="ink" />
    </aside>
  );
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
  icon: NavGroup['icon'];
  active: boolean;
  count: number;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-[9px] px-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        active
          ? 'text-nav-foreground bg-[var(--nav-active)] font-semibold'
          : 'text-nav-muted hover:text-nav-foreground hover:bg-[var(--nav-hover)]',
      )}
    >
      <Icon aria-hidden className="size-[17px] shrink-0" strokeWidth={1.9} />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          aria-label={`${count} need${count === 1 ? 's' : ''} attention`}
          className="bg-status-warning/20 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] text-[oklch(0.86_0.14_78)]"
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
      type="button"
      onClick={toggle}
      className="text-nav-muted hover:text-nav-foreground flex h-9 w-full items-center gap-2 rounded-[10px] border border-[var(--nav-line)] bg-white/[0.04] px-2.5 text-[13px] transition-colors outline-none hover:border-white/20 focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <SearchIcon aria-hidden className="size-3.5" />
      <span className="flex-1 text-left">Ask or jump…</span>
      <kbd className="rounded-md border border-[var(--nav-line)] bg-white/[0.06] px-1.5 font-mono text-[11px] leading-4">⌘K</kbd>
    </button>
  );
}

function OrgName(): React.JSX.Element | null {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  if (!org.data?.name) return null;
  return (
    <span className="text-nav-muted truncate border-l border-white/15 pl-2.5 text-xs">
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
      className="text-nav-muted hover:text-nav-foreground flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40"
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
          <span>{nodes.total === 1 ? 'server online' : 'servers online'}</span>
        </>
      ) : (
        <TextSkeleton className="w-24 bg-white/10" />
      )}
    </Link>
  );
}
