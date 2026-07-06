import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Read-only geo-DNS status for one stack's hosts. Records derive from ingress
 * and zones are managed on Edge & ingress — nothing to edit here.
 */
export function StackDnsStatus({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const view = useQuery({
    ...trpc.geodns.dnsView.queryOptions({ stack }),
    refetchInterval: 10_000,
  });
  const rows = view.data ?? [];

  return (
    <section className="space-y-4">
      <h2 className="headline text-xl">
        Geo-<em>DNS</em>
      </h2>
      {view.isPending ? (
        <div className="shimmer-line h-10 rounded-xl" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No geo-DNS zones match this stack's domains.{' '}
          <Link to="/ingress" className="underline underline-offset-2">
            Manage zones on Edge & ingress
          </Link>
          .
        </p>
      ) : (
        <Card className="card-pop border-0">
          <CardContent className="divide-border divide-y p-0">
            {rows.map((r) => (
              <div key={`${r.zone}-${r.host}-${r.source}`} className="flex items-center gap-3 px-6 py-3.5">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    r.healthyCount > 0 ? 'bg-status-online' : 'bg-status-warning',
                  )}
                />
                <span className="mono-data min-w-0 flex-1 truncate font-medium">{r.host}</span>
                <span className="text-muted-foreground text-sm">
                  resolves via swarmy geo-DNS · {r.healthyCount} healthy region
                  {r.healthyCount === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
