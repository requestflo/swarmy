import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { isSystemStack } from '@swarmy/core';
import { STACK_TABS, SYSTEM_STACK_TABS } from '@/lib/stack-nav';

const BASE =
  'flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const ON = cn(BASE, 'border-primary text-foreground');
const OFF = cn(BASE, 'text-muted-foreground hover:text-foreground border-transparent');

/**
 * The app workspace tabs, Calm style (a hairline strip, coral underline on the
 * current tab), one per surface, each a real URL. Scrolls sideways on a phone.
 * The `swarmy-system` platform stack shows only the tabs that apply to shared
 * plumbing (Overview + Logs); a deep link to another still renders.
 */
export function StackTabStrip({ stack }: { stack: string }): React.JSX.Element {
  const tabs = isSystemStack(stack) ? SYSTEM_STACK_TABS : STACK_TABS;
  // The shared analytics/replay settings page sits under the Analytics tab.
  const rumSettings = /^\/stacks\/[^/]+\/rum-settings(\/|$)/.test(useLocation().pathname);
  return (
    <nav aria-label={`${stack} pages`} className="scrollbar-none border-border -mb-px flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          params={{ name: stack }}
          activeOptions={{ exact: tab.exact ?? false }}
          activeProps={{ className: ON, 'aria-current': 'page' }}
          inactiveProps={{ className: rumSettings && tab.to === '/stacks/$name/analytics' ? ON : OFF }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
