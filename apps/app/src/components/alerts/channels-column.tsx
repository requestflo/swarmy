import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import type { AlertQuietHoursView, AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { CodeView } from '@/components/calm';
import { AddChannelCard } from './add-channel-card';
import { alertsCode } from './alerts-code';
import { ChannelRow } from './channel-row';
import { QuietHoursRow } from './quiet-hours-row';

interface ChannelsColumnProps {
  channels: NotificationChannelView[];
  rules: AlertRuleView[];
  /** The rule in the editor, for the Code view. */
  rule: AlertRuleView | null;
  quietHours: AlertQuietHoursView | undefined;
  className?: string;
}

/**
 * CHANNELS · encrypted · never shown again: one row per channel with Send test
 * and Edit, then Add a channel for every kind createChannel accepts, then the
 * workspace quiet hours. At Code depth the rule, channels and quiet hours sit
 * on top as read-only JSON.
 */
export function ChannelsColumn({ channels, rules, rule, quietHours, className }: ChannelsColumnProps): React.JSX.Element {
  const [adding, setAdding] = React.useState(false);
  const usedBy = (id: string): number => rules.filter((r) => r.channelIds.includes(id)).length;
  return (
    <aside aria-label="Channels" className={cn('flex min-w-0 flex-col gap-3', className)}>
      <CodeView title="Alerts as code" tabs={alertsCode(rule, rules, channels, quietHours)} note="Dashboard setting · no REST yet" />
      <p className="text-muted-foreground flex flex-wrap justify-between gap-x-3 font-mono text-[11px]">
        <span className="tracking-[0.08em] uppercase">Channels</span>
        <span>encrypted · never shown again</span>
      </p>
      {channels.length === 0 ? (
        <p className="calm-card text-muted-foreground px-4 py-4 text-sm">
          Nowhere yet. Alerts only help if they reach someone: add Slack, an email or a webhook and send it a test.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {channels.map((c) => (
            <ChannelRow key={c.id} channel={c} usedBy={usedBy(c.id)} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddChannelCard onClose={() => setAdding(false)} />
      ) : (
        <Button variant="outline" className="w-fit pointer-coarse:min-h-11" onClick={() => setAdding(true)}>
          <PlusIcon className="size-4" /> Add a channel
        </Button>
      )}
      <div className="border-border mt-1 border-t pt-3">
        <QuietHoursRow quiet={quietHours} />
      </div>
    </aside>
  );
}
