import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { RowList, Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { RuleRow } from './rule-row';

/** What swarmy watches: every rule as a sentence; switch and edit them from Controls. */
export function RulesTable(): React.JSX.Element {
  const trpc = useTRPC();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const rules = useQuery({ ...trpc.alerts.rules.queryOptions(), refetchInterval: 30_000 });
  const channels = useQuery(trpc.alerts.channels.queryOptions());
  const rows = rules.data ?? [];
  const on = rows.filter((r) => r.enabled).length;

  if (rules.isLoading) return <CardSkeleton />;
  if (rules.isError) return <ErrorState title="Couldn’t load the rules." error={rules.error} retry={() => void rules.refetch()} />;
  return (
    <Section title="What swarmy watches" count={`${rows.length} rules · ${on} on`} hint="checked every 30 s" flush>
      <RowList label="Alert rules">
        {rows.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            channels={channels.data ?? []}
            expanded={expandedId === rule.id}
            onToggle={() => setExpandedId((id) => (id === rule.id ? null : rule.id))}
          />
        ))}
      </RowList>
    </Section>
  );
}
