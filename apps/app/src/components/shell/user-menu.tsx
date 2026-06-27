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

/** Avatar trigger + dropdown (profile, appearance, sign out). Shared by both shells. */
export function UserMenu({ side = 'bottom' }: { side?: 'bottom' | 'top' }): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const whoami = useQuery(trpc.org.whoami.queryOptions());
  const initial = (whoami.data?.name ?? whoami.data?.email ?? '?').slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full ring-offset-background focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none">
          <Avatar>
            <AvatarFallback className="bg-primary/15 text-foreground font-bold">{initial}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate font-medium">{whoami.data?.name ?? 'You'}</span>
          <span className="text-muted-foreground truncate text-xs font-normal">{whoami.data?.email}</span>
        </DropdownMenuLabel>
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
