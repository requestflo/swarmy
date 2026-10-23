import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@swarmy/ui';

/**
 * "Add data": the existing ways to make something — a database, cache or
 * search in an app's Data tab, or a bucket on Files & buckets. It is the
 * page's coral action only when nothing needs you.
 */
export function AddDataMenu({ apps, primary }: { apps: string[]; primary: boolean }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={primary ? 'default' : 'outline'}>
          <PlusIcon className="size-4" /> Add data
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuItem asChild>
          <Link to="/data/buckets" search={{ create: true }}>
            A bucket for files
          </Link>
        </DropdownMenuItem>
        {apps.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">A database, cache or search for…</DropdownMenuLabel>
            {apps.map((app) => (
              <DropdownMenuItem key={app} asChild>
                <Link to="/stacks/$name/data" params={{ name: app }}>
                  {app}
                </Link>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
