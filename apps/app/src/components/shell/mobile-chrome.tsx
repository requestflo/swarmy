import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BoxesIcon, GaugeIcon, LogOutIcon, PlusIcon, ServerIcon, SettingsIcon } from 'lucide-react';
import { authClient } from '@swarmy/auth/client';
import {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import { ThemeMenuItems } from '@/components/theme-menu';

export function MobileHeader(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const whoami = useQuery(trpc.org.whoami.queryOptions());
  return (
    <header className="bg-background/85 sticky top-0 z-30 flex h-14 items-center justify-between border-b px-4 backdrop-blur lg:hidden">
      <Wordmark />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-full">
            <Avatar>
              <AvatarFallback className="bg-primary/15 text-foreground">
                {(whoami.data?.name ?? whoami.data?.email ?? '?').slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <ThemeMenuItems />
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              await authClient.signOut();
              await navigate({ to: '/login' });
            }}
          >
            <LogOutIcon className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

const TABS = [
  { to: '/', label: 'Overview', icon: GaugeIcon, exact: true },
  { to: '/nodes', label: 'Nodes', icon: ServerIcon, exact: false },
  { to: '/services', label: 'Services', icon: BoxesIcon, exact: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, exact: false },
] as const;

export function MobileTabBar(): React.JSX.Element {
  return (
    <nav className="bg-background/90 fixed inset-x-0 bottom-0 z-30 flex items-end justify-around border-t px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur lg:hidden">
      {TABS.slice(0, 2).map((t) => (
        <Tab key={t.to} {...t} />
      ))}
      <Link
        to="/services/new"
        className="bg-primary text-primary-foreground shadow-[0_8px_24px_-6px_var(--primary)] -mt-6 flex size-14 items-center justify-center rounded-full ring-4 ring-background"
        aria-label="New service"
      >
        <PlusIcon className="size-6" />
      </Link>
      {TABS.slice(2).map((t) => (
        <Tab key={t.to} {...t} />
      ))}
    </nav>
  );
}

function Tab({
  to,
  label,
  icon: Icon,
  exact,
}: {
  to: string;
  label: string;
  icon: typeof GaugeIcon;
  exact: boolean;
}): React.JSX.Element {
  return (
    <Link to={to} activeOptions={{ exact }} className="flex-1">
      {({ isActive }) => (
        <span
          className={cn(
            'flex flex-col items-center gap-1 py-1 text-[10px] font-medium transition-colors',
            isActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-5" />
          {label}
        </span>
      )}
    </Link>
  );
}
