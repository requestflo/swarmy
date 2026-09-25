import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';

export interface CalmTab {
  to: string;
  label: string;
  count?: number;
  exact?: boolean;
}

/** In-page tabs for a nav row's pages (Network: Domains · Edge · Mesh …). */
export function CalmTabs({ tabs, label }: { tabs: CalmTab[]; label: string }): React.JSX.Element {
  const { pathname } = useLocation();
  const active = tabs
    .filter((t) => (t.exact ? pathname === t.to : pathname === t.to || pathname.startsWith(`${t.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
  return (
    <nav aria-label={label} className="border-border -mb-px flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const on = t.to === active;
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              on ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {t.label}
            {t.count ? (
              <span className="bg-status-warning/20 text-tone-warn flex min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[11px]">
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
