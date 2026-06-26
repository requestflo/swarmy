import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import {
  BoxesIcon,
  ContainerIcon,
  GaugeIcon,
  LayersIcon,
  LogOutIcon,
  MoonIcon,
  NetworkIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react';
import { authClient } from '@swarmy/auth/client';
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusBadge,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const NAV = [
  { to: '/', label: 'Overview', icon: GaugeIcon, exact: true },
  { to: '/nodes', label: 'Nodes', icon: ServerIcon, exact: false },
  { to: '/services', label: 'Services', icon: BoxesIcon, exact: false },
  { to: '/stacks', label: 'Stacks', icon: LayersIcon, exact: false },
  { to: '/ingress', label: 'Ingress', icon: NetworkIcon, exact: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, exact: false },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const summary = useQuery({
    ...trpc.system.dashboardSummary.queryOptions(),
    refetchInterval: 5_000,
  });
  const whoami = useQuery(trpc.org.whoami.queryOptions());

  const online = summary.data?.nodes.online ?? 0;
  const total = summary.data?.nodes.total ?? 0;

  return (
    <div className="bg-background flex min-h-screen">
      <aside className="bg-card/40 sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
            <ContainerIcon className="size-4" />
          </div>
          <span className="font-semibold tracking-tight">swarmy</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              className="group"
            >
              {({ isActive }) => (
                <span
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="text-muted-foreground border-t p-4 text-xs">
          <StatusBadge
            tone={online > 0 ? 'online' : 'offline'}
            label={`${online}/${total} nodes online`}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/80 sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b px-6 backdrop-blur">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{org.data?.name ?? 'swarmy'}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <SunIcon className="hidden size-4 dark:block" />
              <MoonIcon className="size-4 dark:hidden" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                  <Avatar>
                    <AvatarFallback>
                      {(whoami.data?.name ?? whoami.data?.email ?? '?').slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span className="truncate text-sm">{whoami.data?.name ?? 'You'}</span>
                    <span className="text-muted-foreground truncate text-xs font-normal">
                      {whoami.data?.email}
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={async () => {
                    await authClient.signOut();
                    await navigate({ to: '/login' });
                  }}
                >
                  <LogOutIcon className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
