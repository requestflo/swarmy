import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { isSystemStack } from '@swarmy/core';
import { STACK_TABS, SYSTEM_STACK_TABS } from '@/lib/stack-nav';
import { stackNavAt } from '@/lib/stack-nav-match';
import { StackSubTabStrip } from './stack-sub-tabs';
import { useRevealActive } from './use-reveal-active';

const BASE =
  'flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const ON = cn(BASE, 'border-primary text-foreground');
const OFF = cn(BASE, 'text-muted-foreground hover:text-foreground border-transparent');

/**
 * The app workspace tabs, Calm style (a hairline strip, coral underline on the
 * current tab), each a real URL, then the current tab's quiet sub-tab strip
 * (Data, Observability, Config). Both scroll sideways inside themselves on a
 * phone. The `swarmy-system` platform stack shows only the tabs that apply to
 * shared plumbing; a deep link to another still renders.
 */
export function StackTabStrip({ stack }: { stack: string }): React.JSX.Element {
  const system = isSystemStack(stack);
  const tabs = system ? SYSTEM_STACK_TABS : STACK_TABS;
  const { tab: current, sub } = stackNavAt(useLocation().pathname);
  const nav = useRevealActive<HTMLElement>(current?.to);
  return (
    <div className="flex min-w-0 flex-col">
      <nav ref={nav} aria-label={`${stack} pages`} className="scrollbar-none border-border relative -mb-px flex min-w-0 gap-1 overflow-x-auto border-b">
        {tabs.map((tab) => {
          const on = tab.to === current?.to;
          return (
            <Link key={tab.to} to={tab.to} params={{ name: stack }} activeOptions={{ exact: true }} aria-current={on ? 'page' : undefined} className={on ? ON : OFF}>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {current?.subs ? <StackSubTabStrip stack={stack} tab={current} active={sub} system={system} /> : null}
    </div>
  );
}
