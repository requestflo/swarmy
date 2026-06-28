import * as React from 'react';
import { ArrowUpRightIcon, LayersIcon, MoonIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { STATUS_TONE, type StackStat } from './stack-aggregates';

interface StackCardProps {
  stat: StackStat;
  onOpen: () => void;
}

/**
 * A Docker stack as a premium, clickable overview card (Hot Signal): aggregate
 * status dot, stack name, the headline replica number, the service / link counts,
 * and a dot per service tinted by its own status. Clicking drills into the
 * service-level canvas scoped to just this stack.
 */
export function StackCard({ stat, onOpen }: StackCardProps): React.JSX.Element {
  const { label, ungrouped, tone, serviceCount, running, desired, linkCount, services } = stat;
  const healthy = desired > 0 && running >= desired;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'card-pop card-pop-hover group relative w-full overflow-hidden rounded-3xl p-6 text-left',
        'transition-transform hover:-translate-y-0.5',
        'focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn('size-3 shrink-0 rounded-full', tone === 'progress' && 'animate-pulse')}
          style={{ background: `var(--status-${tone})` }}
        />
        <span
          className={cn(
            'font-display truncate text-xl font-bold tracking-tight',
            ungrouped && 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <ArrowUpRightIcon className="text-muted-foreground ml-auto size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <div className="mt-5 flex items-end gap-1.5">
        <span
          className={cn(
            'mono-data text-4xl font-bold tabular-nums',
            desired === 0
              ? 'text-status-idle'
              : healthy
                ? 'text-status-online'
                : 'text-status-warning',
          )}
        >
          {running}
          <span className="text-muted-foreground/60">/{desired}</span>
        </span>
        <span className="text-muted-foreground mb-1 text-xs">containers up</span>
      </div>

      <div className="text-muted-foreground mono-data mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <LayersIcon className="size-3.5" />
          {serviceCount} {serviceCount === 1 ? 'service' : 'services'}
        </span>
        <span>
          {linkCount} {linkCount === 1 ? 'link' : 'links'}
        </span>
        {desired === 0 && (
          <span className="text-status-idle inline-flex items-center gap-1">
            <MoonIcon className="size-3.5" /> asleep
          </span>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {services.map((s) => (
          <span
            key={s.id}
            title={`${s.name} · ${s.status}`}
            className="size-2 rounded-full"
            style={{ background: `var(--status-${STATUS_TONE[s.status]})` }}
          />
        ))}
      </div>
    </button>
  );
}
