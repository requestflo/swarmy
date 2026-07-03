import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RuleRow } from './rule-row';

/** Rules table: enable toggle per rule, expand a row to edit threshold/channels. */
export function RulesTable(): React.JSX.Element {
  const trpc = useTRPC();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const rules = useQuery({ ...trpc.alerts.rules.queryOptions(), refetchInterval: 30_000 });
  const rows = rules.data ?? [];

  return (
    <section>
      <h2 className="headline mb-3 text-xl">Rules</h2>
      {rules.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-9 rounded-lg" />
          ))}
        </div>
      ) : rules.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<ShieldAlertIcon />}
            title="Couldn't load rules"
            description={rules.error.message}
            action={
              <Button variant="outline" onClick={() => void rules.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card-pop overflow-hidden">
          <div className="text-muted-foreground mono-label hidden grid-cols-[1.6fr_7rem_6rem_6rem_3.5rem_2.5rem] items-center gap-3 border-b border-border px-5 py-2.5 !text-[10px] lg:grid">
            <span>Rule</span>
            <span className="text-right">Threshold</span>
            <span className="text-right">For</span>
            <span className="text-right">Channels</span>
            <span className="text-right">On</span>
            <span />
          </div>
          <div className="divide-border divide-y">
            {rows.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                expanded={expandedId === rule.id}
                onToggle={() => setExpandedId((id) => (id === rule.id ? null : rule.id))}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
