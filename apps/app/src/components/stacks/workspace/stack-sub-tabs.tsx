import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import type { StackSubTab, StackTab } from '@/lib/stack-nav';
import { useRevealActive } from './use-reveal-active';

const BASE =
  'flex min-h-11 shrink-0 items-center rounded-[10px] px-3 text-[13px] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * The quiet secondary strip under the app tabs (boards AppScaling · DbStudio ·
 * Errors): the current tab's pages as small pills, the current one washed.
 * Scrolls sideways inside itself at phone width, never the page.
 */
export function StackSubTabStrip({
  stack,
  tab,
  active,
  system,
}: {
  stack: string;
  tab: StackTab;
  active: StackSubTab | null;
  system: boolean;
}): React.JSX.Element | null {
  const nav = useRevealActive<HTMLElement>(active?.to);
  const subs = (tab.subs ?? []).filter((s) => !system || s.systemSafe);
  if (subs.length < 2) return null;
  return (
    <nav ref={nav} aria-label={`${tab.label} pages`} className="scrollbar-none relative flex min-w-0 gap-1 overflow-x-auto pt-2">
      {subs.map((s) => {
        const on = s.to === active?.to;
        return (
          <Link
            key={s.to}
            to={s.to}
            params={{ name: stack }}
            activeOptions={{ exact: true }}
            aria-current={on ? 'page' : undefined}
            className={cn(BASE, on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
