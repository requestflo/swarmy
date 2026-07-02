import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { BoxesIcon, LayoutGridIcon, PlusIcon, SearchIcon, ServerIcon } from 'lucide-react';
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
  type CommandAction,
} from '@/lib/destinations';
import { useNavBadges } from '@/lib/use-nav-badges';

/** Compact mobile header: wordmark + search + avatar. No hamburger. */
export function MobileHeader(): React.JSX.Element {
  const { toggle } = useCommandPalette();
  return (
    <header className="bg-background/85 sticky top-0 z-30 flex h-14 items-center justify-between border-b px-4 backdrop-blur lg:hidden">
      <Wordmark />
      <div className="flex items-center gap-3">
        <button onClick={toggle} aria-label="Search" className="text-muted-foreground">
          <SearchIcon className="size-5" />
        </button>
        <UserMenu side="bottom" />
      </div>
    </header>
  );
}

const TABS = [
  { to: '/', label: 'Apps', icon: BoxesIcon, match: (p: string) => p === '/' || p.startsWith('/services') || p.startsWith('/stacks') },
  { to: '/nodes', label: 'Infra', icon: ServerIcon, match: (p: string) => p.startsWith('/nodes') },
] as const;

/**
 * Bottom tab bar: the two planes flanking a centre coral Create FAB (a sheet of
 * every "new thing"), plus a "More" tab that opens the full grouped navigation
 * so every one of the 40 destinations is reachable on mobile too.
 */
export function MobileTabBar(): React.JSX.Element {
  const { pathname } = useLocation();
  return (
    <nav className="bg-background/90 fixed inset-x-0 bottom-0 z-30 flex items-end justify-around border-t px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur lg:hidden">
      {TABS.map((t) => (
        <Tab key={t.to} to={t.to} label={t.label} icon={t.icon} active={t.match(pathname)} />
      ))}
      <CreateFab />
      <SearchTab />
      <MoreTab />
    </nav>
  );
}

function SearchTab(): React.JSX.Element {
  const { toggle } = useCommandPalette();
  return (
    <button
      onClick={toggle}
      className="text-muted-foreground flex flex-1 flex-col items-center gap-1 py-1 text-[10px] font-medium"
    >
      <SearchIcon className="size-5" />
      Search
    </button>
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
        aria-label="Create"
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

function MoreTab(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { pathname } = useLocation();
  const badges = useNavBadges();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        onClick={() => setOpen(true)}
        className="text-muted-foreground flex flex-1 flex-col items-center gap-1 py-1 text-[10px] font-medium"
      >
        <LayoutGridIcon className="size-5" />
        More
      </button>
      <SheetContent side="right" className="w-[86%] max-w-sm overflow-y-auto p-0">
        <SheetHeader className="pb-2">
          <SheetTitle>Navigate</SheetTitle>
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
}: {
  to: string;
  label: string;
  icon: typeof BoxesIcon;
  active: boolean;
}): React.JSX.Element {
  return (
    <Link to={to} className="flex-1">
      <span
        className={cn(
          'flex flex-col items-center gap-1 py-1 text-[10px] font-medium transition-colors',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        <Icon className="size-5" />
        {label}
      </span>
    </Link>
  );
}
