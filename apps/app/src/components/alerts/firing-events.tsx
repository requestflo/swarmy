import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, RowList, Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { relTime } from '@/lib/format';
import { AckButton } from './ack-button';
import { stackForResource, useServiceStackMap } from './use-service-stack-map';

/** "Firing now": each open alert as a quiet row with Ack; a toggle peeks at what resolved recently. */
export function FiringEvents(): React.JSX.Element {
  const trpc = useTRPC();
  const [showResolved, setShowResolved] = React.useState(false);
  const stackMap = useServiceStackMap();
  const firing = useQuery({ ...trpc.alerts.events.queryOptions({ status: 'firing', limit: 100 }), refetchInterval: 10_000 });
  const resolved = useQuery({
    ...trpc.alerts.events.queryOptions({ status: 'resolved', limit: 20 }),
    refetchInterval: 30_000,
    enabled: showResolved,
  });
  if (firing.isLoading) return <CardSkeleton />;
  if (firing.isError) return <ErrorState title="Couldn’t load what’s firing." error={firing.error} retry={() => void firing.refetch()} />;
  const rows = firing.data ?? [];
  return (
    <Section
      title="Firing now"
      count={rows.length ? rows.length : undefined}
      flush
      action={
        <Button variant="ghost" size="sm" aria-pressed={showResolved} className="pointer-coarse:min-h-11" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide resolved' : 'Recently resolved'}
        </Button>
      }
    >
      <RowList label="Firing alerts">
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">Nothing is firing. swarmy keeps watching and tells you here first.</p>
        ) : (
          rows.map((e) => {
            const app = stackForResource(e.resource, stackMap);
            return (
              <CalmRow
                key={e.id}
                tone={e.severity === 'critical' ? 'bad' : 'warn'}
                name={e.ruleName ?? e.signal}
                sub={`${app ? `app ${app} · ` : ''}fired ${relTime(e.firedAt)}`}
                say={e.message}
                trailing={<AckButton id={e.id} />}
              />
            );
          })
        )}
        {showResolved
          ? (resolved.data ?? []).map((e) => (
              <CalmRow key={e.id} tone="ok" name={e.ruleName ?? e.signal} sub={e.resource} say={e.message} word="Resolved" tech={`resolved ${relTime(e.resolvedAt ?? e.firedAt)}`} />
            ))
          : null}
        {showResolved && resolved.isSuccess && resolved.data.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">Nothing resolved recently.</p>
        ) : null}
      </RowList>
    </Section>
  );
}
