import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, ShieldAlertIcon } from 'lucide-react';
import type { AlertRuleView, AlertSignal } from '@swarmy/core';
import { ALERT_SIGNAL_INFO } from '@swarmy/core';
import { Button, EmptyState, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { forDuration } from './alert-tones';
import { EditRuleDialog } from './edit-rule-dialog';

function signalInfo(signal: string): { unit: string | null; description: string } {
  const info = ALERT_SIGNAL_INFO[signal as AlertSignal];
  return info ? { unit: info.unit, description: info.description } : { unit: null, description: '' };
}

/** Rules table: enable toggle per rule + threshold/channel editing dialog. */
export function RulesTable(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState<AlertRuleView | null>(null);

  const rules = useQuery({ ...trpc.alerts.rules.queryOptions(), refetchInterval: 30_000 });
  const toggle = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} ${r.enabled ? 'enabled' : 'muted'}.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

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
            {rows.map((rule) => {
              const info = signalInfo(rule.signal);
              return (
                <div
                  key={rule.id}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-5 py-3 lg:grid-cols-[1.6fr_7rem_6rem_6rem_3.5rem_2.5rem]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{rule.name}</span>
                    <span className="mono-data text-muted-foreground block truncate text-xs">
                      {rule.signal}
                    </span>
                  </span>
                  <span className="mono-data hidden text-right text-sm lg:block">
                    {rule.threshold !== null ? `${rule.threshold}${info.unit ?? ''}` : '—'}
                  </span>
                  <span className="mono-data text-muted-foreground hidden text-right text-xs lg:block">
                    {forDuration(rule.forSeconds)}
                  </span>
                  <span className="text-muted-foreground hidden text-right text-xs lg:block">
                    {rule.channelIds.length === 0 ? 'all' : rule.channelIds.length}
                  </span>
                  <span className="flex justify-end">
                    <Switch
                      checked={rule.enabled}
                      disabled={toggle.isPending}
                      onCheckedChange={(enabled) => toggle.mutate({ id: rule.id, enabled })}
                      aria-label={`Toggle ${rule.name}`}
                    />
                  </span>
                  <span className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${rule.name}`}
                      onClick={() => setEditing(rule)}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <EditRuleDialog rule={editing} onClose={() => setEditing(null)} />
    </section>
  );
}
