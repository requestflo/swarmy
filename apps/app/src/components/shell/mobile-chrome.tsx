import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { BoxesIcon, RocketIcon, SearchIcon, ServerIcon, SettingsIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Wordmark } from '@/components/wordmark';
import { UserMenu } from './user-menu';
import { useCommandPalette } from './command-palette-provider';

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

const TABS_RIGHT = [{ to: '/settings', label: 'Settings', icon: SettingsIcon, match: (p: string) => p.startsWith('/settings') }] as const;

/** Bottom tab bar: planes flanking a centre coral Deploy FAB, plus Search + Settings. */
export function MobileTabBar(): React.JSX.Element {
  const { toggle } = useCommandPalette();
  const { pathname } = useLocation();
  return (
    <nav className="bg-background/90 fixed inset-x-0 bottom-0 z-30 flex items-end justify-around border-t px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur lg:hidden">
      {TABS.map((t) => (
        <Tab key={t.to} {...t} active={t.match(pathname)} />
      ))}
      <Link
        to="/services/new"
        className="bg-primary text-primary-foreground ring-background -mt-6 flex size-14 items-center justify-center rounded-full shadow-[0_8px_24px_-6px_var(--primary)] ring-4"
        aria-label="Deploy a new service"
      >
        <RocketIcon className="size-6" />
      </Link>
      <button onClick={toggle} className="text-muted-foreground flex flex-1 flex-col items-center gap-1 py-1 text-[10px] font-medium">
        <SearchIcon className="size-5" />
        Search
      </button>
      {TABS_RIGHT.map((t) => (
        <Tab key={t.to} {...t} active={t.match(pathname)} />
      ))}
    </nav>
  );
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
