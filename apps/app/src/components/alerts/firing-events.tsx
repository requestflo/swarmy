import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PartyPopperIcon } from 'lucide-react';
import { Button, EmptyState, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EventCard } from './event-card';

/**
 * "Firing now" — every open alert event (poll 10s) with one-click ack, plus a
 * toggle to peek at the recently resolved feed.
 */
export function FiringEvents(): React.JSX.Element {
  const trpc = useTRPC();
  const [showResolved, setShowResolved] = React.useState(false);

  const firing = useQuery({
    ...trpc.alerts.events.queryOptions({ status: 'firing', limit: 100 }),
    refetchInterval: 10_000,
  });
  const resolved = useQuery({
    ...trpc.alerts.events.queryOptions({ status: 'resolved', limit: 20 }),
    refetchInterval: 30_000,
    enabled: showResolved,
  });

  const rows = firing.data ?? [];
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="headline text-xl">
          Firing now{' '}
          {rows.length > 0 ? <span className="mono-data text-base">({rows.length})</span> : null}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className={cn(showResolved && 'bg-accent')}
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide resolved' : 'Recently resolved'}
        </Button>
      </div>

      {firing.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-10 rounded-lg" />
          ))}
        </div>
      ) : firing.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<PartyPopperIcon />}
            title="Couldn't load events"
            description={firing.error.message}
            action={
              <Button variant="outline" onClick={() => void firing.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<PartyPopperIcon />}
            title="Nothing is firing."
            description="swarmy is watching nodes, services, databases, backups, disks and queues — when something breaks you'll see it here first."
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {showResolved ? (
        <div className="mt-3">
          <h3 className="mono-label text-muted-foreground mb-2">Recently resolved</h3>
          {resolved.isLoading ? (
            <div className="card-pop p-5">
              <div className="shimmer-line h-8 rounded-lg" />
            </div>
          ) : (resolved.data ?? []).length === 0 ? (
            <p className="text-muted-foreground px-1 text-sm">Nothing resolved recently.</p>
          ) : (
            <div className="card-pop divide-border divide-y overflow-hidden opacity-80">
              {(resolved.data ?? []).map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
