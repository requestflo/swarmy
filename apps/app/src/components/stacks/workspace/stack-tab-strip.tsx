import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { isSystemStack } from '@swarmy/core';
import { STACK_TABS, SYSTEM_STACK_TABS } from '@/lib/stack-nav';

const BASE =
  'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors';

/**
 * The workspace tab strip: pill tabs, one per stack surface, each a real URL.
 * Active = navy ink pill (the product speaking); scrolls horizontally on
 * mobile so nothing is ever more than a swipe away. The `swarmy-system`
 * platform stack only shows the surfaces that apply to shared plumbing
 * (Overview + Observability) — app-oriented tabs stay hidden, though a
 * deep link to one still renders (see stack-workspace-layout.tsx).
 */
export function StackTabStrip({ stack }: { stack: string }): React.JSX.Element {
  const tabs = isSystemStack(stack) ? SYSTEM_STACK_TABS : STACK_TABS;
  return (
    <nav className="scrollbar-none -mx-1 mt-5 flex gap-1 overflow-x-auto border-b pb-3 pl-1">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          params={{ name: stack }}
          activeOptions={{ exact: tab.exact ?? false }}
          activeProps={{ className: cn(BASE, 'bg-ink text-ink-foreground shadow-sm') }}
          inactiveProps={{
            className: cn(BASE, 'text-muted-foreground hover:text-foreground hover:bg-accent'),
          }}
        >
          <tab.icon className="size-4" />
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
