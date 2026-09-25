import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { BellIcon, BoxesIcon, HomeIcon, LayoutGridIcon, PlusIcon, SearchIcon, ServerIcon } from 'lucide-react';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  cn,
} from '@swarmy/ui';
import { Wordmark } from '@/components/wordmark';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';
import {
  PRIMARY,
  SECTIONS,
  NAV_GROUP_ORDER,
  QUICK_ACTIONS,
  CREATE_KIND_LABEL,
  navRowForPathname,
  type CommandAction,
} from '@/lib/destinations';
import { useNavBadges } from '@/lib/use-nav-badges';

/** Compact mobile header: wordmark, search, every page, avatar. No hamburger. */
export function MobileHeader(): React.JSX.Element {
  const { toggle } = useCommandPalette();
  return (
    <header className="bg-background/85 sticky top-0 z-30 flex h-14 items-center justify-between border-b px-4 backdrop-blur lg:hidden">
      <Link to="/overview" aria-label="swarmy home" className="flex min-h-11 items-center">
        <Wordmark />
      </Link>
      <div className="flex items-center gap-1">
        <button type="button" onClick={toggle} aria-label="Ask or jump" className="text-muted-foreground flex size-11 items-center justify-center rounded-full">
          <SearchIcon className="size-5" />
        </button>
        <AllPagesSheet />
        <UserMenu side="bottom" />
      </div>
    </header>
  );
}

const TABS = [
  { to: '/overview', label: 'Overview', icon: HomeIcon, match: (p: string) => p === '/overview' },
  { to: '/', label: 'Apps', icon: BoxesIcon, match: (p: string) => navRowForPathname(p) === 'Apps' },
] as const;
const TABS_RIGHT = [
  { to: '/nodes', label: 'Servers', icon: ServerIcon, match: (p: string) => navRowForPathname(p) === 'Servers' },
  { to: '/activity', label: 'Activity', icon: BellIcon, match: (p: string) => navRowForPathname(p) === 'Activity' },
] as const;

/**
 * Bottom tab bar: Overview · Apps · the coral + (a sheet of every "new
 * thing") · Servers · Activity. Every other page is one tap away in the
 * header's "All pages" sheet.
 */
export function MobileTabBar(): React.JSX.Element {
  const { pathname } = useLocation();
  const badges = useNavBadges();
  return (
    <nav aria-label="Main" className="bg-background/90 fixed inset-x-0 bottom-0 z-30 flex items-end justify-around border-t px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 backdrop-blur lg:hidden">
      {TABS.map((t) => (
        <Tab key={t.to} to={t.to} label={t.label} icon={t.icon} active={t.match(pathname)} />
      ))}
      <CreateFab />
      {TABS_RIGHT.map((t) => (
        <Tab
          key={t.to}
          to={t.to}
          label={t.label}
          icon={t.icon}
          active={t.match(pathname)}
          count={t.to === '/activity' ? badges.alertsFiring + badges.incidentsOpen : badges.nodesOffline}
        />
      ))}
    </nav>
  );
}

function CreateFab(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const KIND_ORDER: CommandAction['kind'][] = ['deploy', 'data', 'ops', 'infra'];
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        onClick={() => setOpen(true)}
        className="bg-primary text-primary-foreground ring-background -mt-6 flex size-14 items-center justify-center rounded-full shadow-[0_8px_24px_-6px_var(--primary)] ring-4"
        aria-label="Create: deploy an app, add a server…"
      >
        <PlusIcon className="size-6" />
      </button>
      <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Create</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-8">
          {KIND_ORDER.map((kind) => {
            const items = QUICK_ACTIONS.filter((a) => a.kind === kind);
            if (items.length === 0) return null;
            return (
              <div key={kind}>
                <div className="text-muted-foreground mb-1 px-1 text-xs font-semibold tracking-wider uppercase">
                  {CREATE_KIND_LABEL[kind]}
                </div>
                <div className="space-y-0.5">
                  {items.map((a) => (
                    <SheetClose asChild key={a.id}>
                      <Link to={a.to} className="hover:bg-accent flex items-center gap-3 rounded-xl px-3 py-2.5">
                        <a.icon className="text-primary size-4" />
                        <span className="text-sm font-medium">{a.label}</span>
                      </Link>
                    </SheetClose>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AllPagesSheet(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { pathname } = useLocation();
  const badges = useNavBadges();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="All pages"
        className="text-muted-foreground flex size-11 items-center justify-center rounded-full"
      >
        <LayoutGridIcon className="size-5" />
      </button>
      <SheetContent side="right" className="w-[86%] max-w-sm overflow-y-auto p-0">
        <SheetHeader className="pb-2">
          <SheetTitle>All pages</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-10">
          <div className="space-y-0.5">
            {PRIMARY.map((d) => (
              <SheetClose asChild key={d.to}>
                <Link
                  to={d.to}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5',
                    isActive(pathname, d.to, d.exact) ? 'bg-accent text-primary font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <d.icon className="size-4" />
                  <span className="text-sm font-medium">{d.label}</span>
                </Link>
              </SheetClose>
            ))}
          </div>
          {NAV_GROUP_ORDER.map((group) => (
            <div key={group}>
              <div className="text-muted-foreground mb-1 px-1 text-xs font-semibold tracking-wider uppercase">
                {group}
              </div>
              <div className="space-y-0.5">
                {SECTIONS.filter((s) => s.group === group).map((d) => {
                  const count = d.badge ? badges[d.badge] : 0;
                  return (
                    <SheetClose asChild key={d.to}>
                      <Link
                        to={d.to}
                        className={cn(
                          'flex items-center gap-3 rounded-xl px-3 py-2.5',
                          isActive(pathname, d.to, d.exact) ? 'bg-accent text-primary font-semibold' : 'hover:bg-accent',
                        )}
                      >
                        <d.icon className="size-4 shrink-0" />
                        <span className="flex-1 truncate text-sm font-medium">{d.label}</span>
                        {count > 0 && (
                          <span className="bg-primary text-primary-foreground flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold">
                            {count}
                          </span>
                        )}
                      </Link>
                    </SheetClose>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function isActive(pathname: string, to: string, exact?: boolean): boolean {
  return exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
}

function Tab({
  to,
  label,
  icon: Icon,
  active,
  count = 0,
}: {
  to: string;
  label: string;
  icon: typeof BoxesIcon;
  active: boolean;
  count?: number;
}): React.JSX.Element {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} className="flex min-h-12 flex-1">
      <span
        className={cn(
          'relative flex w-full flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition-colors',
          active ? 'text-foreground font-semibold' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden className="size-5" />
        {label}
        {count > 0 ? (
          <span className="bg-status-warning text-ink absolute top-0 right-[calc(50%-20px)] flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-bold">
            {count}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
