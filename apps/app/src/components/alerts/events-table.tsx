import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ALERT_SIGNALS, type AlertRuleView, type NotificationChannelView, type UpdateAlertRuleInput } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { deliveries } from './events-route';
import { EventsTableRow } from './events-table-row';

const order = (signal: string): number => (ALERT_SIGNALS as readonly string[]).indexOf(signal);

/**
 * EVENTS I CARE ABOUT · Defaults (board 55): one built-in rule per signal —
 * its threshold (click to step through the presets), the level the signal
 * carries, where it goes (All, or picked channels) and on/off. Every change is
 * the existing `alerts.updateRule`, audited and applied on the next check.
 */
export function EventsTable({ rules, channels, className }: { rules: AlertRuleView[]; channels: NotificationChannelView[]; className?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);
  const update = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() }),
      onError: (e) => toast.error(e.message),
      onSettled: () => setBusy(null),
    }),
  );
  const change = (patch: UpdateAlertRuleInput, said: string): void => {
    setBusy(patch.id);
    update.mutate(patch, { onSuccess: (r) => toast.success(`${r.name}: ${said}. It applies on the next check.`) });
  };

  const defaults = rules.filter((r) => r.isDefault).sort((a, b) => order(a.signal) - order(b.signal));
  const live = channels.filter((c) => c.enabled).map((c) => c.id);
  const n = deliveries(defaults, live);
  const removed = ALERT_SIGNALS.length - new Set(defaults.map((r) => r.signal)).size;

  return (
    <Section
      title="Events I care about"
      count={`${n} deliver${n === 1 ? 'y' : 'ies'} configured${removed > 0 ? ` · ${removed} default${removed === 1 ? '' : 's'} removed` : ''} · deleting a default is remembered`}
      flush
      className={className}
    >
      <p className="text-muted-foreground pb-2 text-[13px] leading-relaxed">
        <b className="text-foreground font-semibold">Defaults.</b> One rule per signal. <b className="text-foreground font-semibold">All</b> means every
        enabled channel, so the first channel you add gets everything. Click a threshold to change it. Severity comes from the signal.
      </p>
      <div
        aria-hidden
        className="text-muted-foreground border-border hidden gap-3 border-b pb-1.5 font-mono text-[10.5px] tracking-[0.08em] uppercase md:grid md:grid-cols-[minmax(0,1.3fr)_72px_minmax(0,1.6fr)_44px]"
      >
        <span>Rule</span>
        <span>Level</span>
        <span>Route</span>
        <span>On</span>
      </div>
      <ul aria-label="Default rules" className="divide-border flex flex-col divide-y">
        {defaults.map((r) => (
          <EventsTableRow key={r.id} rule={r} channels={channels} busy={busy === r.id} onChange={change} />
        ))}
      </ul>
    </Section>
  );
}
