import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LayersIcon } from 'lucide-react';
import { EmptyState, StatusBadge, type StatusTone } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const STATUS_TONE: Record<string, StatusTone> = {
  running: 'online',
  deploying: 'progress',
  degraded: 'warning',
  empty: 'neutral',
};

/**
 * The estate's stack strip — every stack workspace, one card, one click away.
 * This is what makes Overview feed the stack-first IA instead of competing
 * with it.
 */
export function StacksHealthStrip(): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 15_000 });
  const rows = stacks.data ?? [];

  return (
    <section className="mt-4">
      <h2 className="font-display mb-3 text-lg font-bold">Stacks</h2>
      {stacks.isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer-line card-pop h-20" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<LayersIcon />}
            title="No stacks yet"
            description="Deploy a blueprint or group services into a stack to see it here."
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {rows.map((s) => (
            <Link key={s.id} to="/stacks/$name" params={{ name: s.name }} className="card-pop card-pop-hover p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{s.name}</span>
                <StatusBadge tone={STATUS_TONE[s.status] ?? 'neutral'} label={s.status} />
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                {s.serviceCount} service{s.serviceCount === 1 ? '' : 's'}
              </p>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
