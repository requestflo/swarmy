import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';

export type ObsTab = 'logs' | 'replays' | 'errors' | 'analytics' | 'rsettings';

const TABS: { key: ObsTab; label: string; to: string }[] = [
  { key: 'logs', label: 'Logs & traces', to: '/stacks/$name/observability' },
  { key: 'replays', label: 'Session replays', to: '/stacks/$name/replays' },
  { key: 'errors', label: 'Errors', to: '/stacks/$name/errors' },
  { key: 'analytics', label: 'Analytics', to: '/stacks/$name/analytics' },
  { key: 'rsettings', label: 'Replay & analytics settings', to: '/stacks/$name/rum-settings' },
];

interface ObsSubTabsProps {
  stack: string;
  active: ObsTab;
  /** Quiet one-line context on the right ("412 sessions today · 10% sampled"). */
  aside?: React.ReactNode;
}

/**
 * The Observability area's sub-tabs — logs & traces, replays, errors,
 * analytics and their settings are one place to look at what visitors
 * experienced. Coral underline, same as a section's tab row.
 */
export function ObsSubTabs({ stack, active, aside }: ObsSubTabsProps): React.JSX.Element {
  return (
    <nav
      aria-label="Observability"
      className="border-border mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-b"
    >
      <div className="scrollbar-none -mb-px flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            // Typed routes: every `to` above is a real child of /stacks/$name.
            to={t.to as '/stacks/$name/observability'}
            params={{ name: stack }}
            aria-current={t.key === active ? 'page' : undefined}
            className={cn(
              'flex items-center border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
              t.key === active
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {aside ? (
        <span className="text-muted-foreground ml-auto hidden pb-2 font-mono text-xs md:block">
          {aside}
        </span>
      ) : null}
    </nav>
  );
}
