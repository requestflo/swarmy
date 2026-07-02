import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@swarmy/ui';
import { useGo } from '@/lib/use-go';
import { QUICK_ACTIONS, CREATE_KIND_LABEL, type CommandAction } from '@/lib/destinations';

const KIND_ORDER: CommandAction['kind'][] = ['deploy', 'data', 'ops', 'infra'];

/**
 * The global "+ Create" menu — one obvious place to start anything, grouped by
 * what you're making. Sits at the top of the sidenav so "make a new thing" is
 * never more than one click away, regardless of which page you're on.
 */
export function CreateMenu({ className }: { className?: string }): React.JSX.Element {
  const go = useGo();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'bg-primary text-primary-foreground flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]',
            className,
          )}
        >
          <PlusIcon className="size-4" />
          Create
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {KIND_ORDER.map((kind, i) => {
          const items = QUICK_ACTIONS.filter((a) => a.kind === kind);
          if (items.length === 0) return null;
          return (
            <React.Fragment key={kind}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                {CREATE_KIND_LABEL[kind]}
              </DropdownMenuLabel>
              {items.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => go(a.to)} className="gap-2">
                  <a.icon className="text-primary size-4" />
                  {a.label}
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
