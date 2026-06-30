import * as React from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { BoxesIcon, ServerIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';

/**
 * The two primary planes as a segmented control: Stacks (the deploy canvas)
 * vs Infrastructure (the cluster). This replaces the top of the old sidenav as
 * the always-visible "where am I" anchor.
 *
 * Active detection is prefix-based so deep routes still light the right plane:
 * anything under /nodes is Infrastructure; everything app-shaped
 * (/, /services, /stacks) is Stacks.
 */
const PLANE_DEFS = [
  { to: '/', label: 'Stacks', icon: BoxesIcon, match: (p: string) => p === '/' || p.startsWith('/services') || p.startsWith('/stacks') },
  { to: '/nodes', label: 'Infrastructure', icon: ServerIcon, match: (p: string) => p.startsWith('/nodes') },
] as const;

export function PlaneTabs({ className }: { className?: string }): React.JSX.Element {
  const { pathname } = useLocation();
  return (
    <div className={cn('bg-muted/60 ring-border inline-flex items-center gap-1 rounded-full p-1 ring-1', className)}>
      {PLANE_DEFS.map((plane) => {
        const active = plane.match(pathname);
        return (
          <Link
            key={plane.to}
            to={plane.to}
            className={cn(
              'flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-bold transition-all',
              active
                ? 'bg-ink text-ink-foreground shadow-[0_6px_18px_-8px_var(--ink)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <plane.icon className="size-4" />
            <span className="hidden sm:inline">{plane.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
