import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BoxesIcon,
  GaugeIcon,
  LayersIcon,
  LogOutIcon,
  NetworkIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  DatabaseBackupIcon,
  ActivityIcon,
  GlobeIcon,
  ShieldIcon,
  GitBranchIcon,
  KeyRoundIcon,
} from 'lucide-react';
import { authClient } from '@swarmy/auth/client';
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Wordmark } from '@/components/wordmark';
import { ThemeMenuItems } from '@/components/theme-menu';

const NAV = [
  { to: '/', label: 'Overview', icon: GaugeIcon, exact: true },
  { to: '/nodes', label: 'Nodes', icon: ServerIcon, exact: false },
  { to: '/services', label: 'Services', icon: BoxesIcon, exact: false },
  { to: '/stacks', label: 'Stacks', icon: LayersIcon, exact: false },
  { to: '/ingress', label: 'Ingress', icon: NetworkIcon, exact: false },
  { to: '/networking', label: 'Networking', icon: GlobeIcon, exact: false },
  { to: '/ci', label: 'CI', icon: GitBranchIcon, exact: false },
  { to: '/geo', label: 'Geo', icon: GlobeIcon, exact: false },
  { to: '/backups', label: 'Backups', icon: DatabaseBackupIcon, exact: false },
  { to: '/observability', label: 'Observability', icon: ActivityIcon, exact: false },
  { to: '/settings/access', label: 'Access', icon: ShieldIcon, exact: false },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRoundIcon, exact: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, exact: false },
] as const;

export function Sidenav(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const whoami = useQuery(trpc.org.whoami.queryOptions());
  const summary = useQuery({
    ...trpc.system.dashboardSummary.queryOptions(),
    refetchInterval: 5_000,
  });
  const online = summary.data?.nodes.online ?? 0;
  const total = summary.data?.nodes.total ?? 0;
  const offline = Math.max(0, total - online);

  return (
    <aside className="ink-block fixed inset-y-0 left-0 z-30 hidden w-64 flex-col p-4 lg:flex">
      <div className="px-2 py-2">
        <Wordmark className="text-ink-foreground" />
        {org.data?.name && (
          <p className="text-ink-foreground/60 mt-0.5 truncate text-xs">{org.data.name}</p>
        )}
      </div>

      <Button className="mt-4 w-full" onClick={() => navigate({ to: '/services/new' })}>
        <PlusIcon className="size-4" /> New service
      </Button>

      <nav className="mt-5 flex flex-1 flex-col gap-1">
        {NAV.map((item) => (
          <Link key={item.to} to={item.to} activeOptions={{ exact: item.exact }}>
            {({ isActive }) => (
              <span
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-ink-foreground text-ink'
                    : 'text-ink-foreground/70 hover:text-ink-foreground hover:bg-white/8',
                )}
              >
                <item.icon className="size-4" />
                {item.label}
                {item.to === '/nodes' && offline > 0 && (
                  <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[10px] font-bold">
                    {offline}
                  </span>
                )}
              </span>
            )}
          </Link>
        ))}
      </nav>

      <div className="text-ink-foreground/70 mb-3 flex items-center gap-2 px-3 text-xs">
        <span className="pulse-dot" style={{ background: 'var(--status-online)' }} />
        <span className="mono-data">
          {online}/{total}
        </span>
        nodes online
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="hover:bg-white/8 flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors">
            <Avatar>
              <AvatarFallback className="bg-primary/20 text-ink-foreground">
                {(whoami.data?.name ?? whoami.data?.email ?? '?').slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-ink-foreground truncate text-sm font-medium">
                {whoami.data?.name ?? 'You'}
              </p>
              <p className="text-ink-foreground/60 truncate text-xs">{whoami.data?.email}</p>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
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
    </aside>
  );
}
