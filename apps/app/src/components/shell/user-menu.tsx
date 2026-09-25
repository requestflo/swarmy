import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LogOutIcon } from 'lucide-react';
import { authClient } from '@swarmy/auth/client';
import {
  Avatar,
  AvatarFallback,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ThemeMenuItems } from '@/components/theme-menu';
import { DepthSegments } from '@/components/calm/depth-dial';
import { useDepthDefault } from '@/components/calm/depth';
import { TextSkeleton } from '@/components/states';

/**
 * Avatar trigger + dropdown (profile, appearance, sign out). Shared by both
 * shells. `tone="ink"` renders a full-width row (avatar + name/email) that reads
 * on the navy sidenav footer; the default is the bare avatar for mobile/topbar.
 */
export function UserMenu({
  side = 'bottom',
  tone = 'default',
}: {
  side?: 'bottom' | 'top';
  tone?: 'default' | 'ink';
}): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const whoami = useQuery(trpc.org.whoami.queryOptions());
  const initial = (whoami.data?.name ?? whoami.data?.email ?? '?').slice(0, 1).toUpperCase();
  // No fake "You" while the identity is still loading — a shimmer instead.
  const displayName: React.ReactNode = whoami.data
    ? (whoami.data.name ?? whoami.data.email ?? 'You')
    : whoami.isError
      ? 'You'
      : <TextSkeleton className="w-20 bg-white/10" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {tone === 'ink' ? (
          <button className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none">
            <Avatar className="size-8">
              <AvatarFallback className="bg-ink-foreground/15 text-ink-foreground font-bold">
                {initial}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="text-ink-foreground block truncate text-sm font-medium">
                {displayName}
              </span>
              <span className="text-ink-foreground/50 block truncate text-xs">{whoami.data?.email}</span>
            </span>
          </button>
        ) : (
          <button className="rounded-full ring-offset-background focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none">
            <Avatar>
              <AvatarFallback className="bg-primary/15 text-foreground font-bold">{initial}</AvatarFallback>
            </Avatar>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate font-medium">{displayName}</span>
          <span className="text-muted-foreground truncate text-xs font-normal">{whoami.data?.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DepthDefaultItem />
        <DropdownMenuSeparator />
        <ThemeMenuItems />
        <DropdownMenuSeparator />
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
  );
}

/** "Show me" inside the user menu — the phone's way to set the default depth. */
function DepthDefaultItem(): React.JSX.Element {
  const { value, set } = useDepthDefault();
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5 lg:hidden">
      <span className="text-muted-foreground text-xs font-medium">Show me</span>
      <DepthSegments value={value} onChange={set} label="How much detail to show by default" size="sm" />
    </div>
  );
}
