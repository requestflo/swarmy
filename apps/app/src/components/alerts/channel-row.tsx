import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import type { NotificationChannelView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { ChannelEdit } from './channel-edit';
import { ChannelKindIcon, maskedTarget } from './channel-kind-icon';

interface TestOutcome {
  at: string;
  ok: boolean;
  detail: string;
}

const hhmm = (): string => new Date().toTimeString().slice(0, 5);

/** One channel: kind icon, name, a masked target, Send test with its result inline, and Edit. */
export function ChannelRow({ channel, usedBy }: { channel: NotificationChannelView; usedBy: number }): React.JSX.Element {
  const trpc = useTRPC();
  const [editing, setEditing] = React.useState(false);
  const [outcome, setOutcome] = React.useState<TestOutcome | null>(null);
  const test = useMutation(
    trpc.alerts.testChannel.mutationOptions({
      onSuccess: (r) => setOutcome({ at: hhmm(), ok: r.ok, detail: r.detail }),
      onError: (e) => setOutcome({ at: hhmm(), ok: false, detail: e.message }),
    }),
  );
  return (
    <li className="calm-card flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <ChannelKindIcon kind={channel.kind} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn('truncate text-[14px] font-semibold', !channel.enabled && 'text-muted-foreground')}>
            {channel.name}
            {channel.enabled ? null : <span className="text-tone-idle ml-2 text-xs font-semibold">off</span>}
          </span>
          <span className="text-muted-foreground font-mono text-[11px] break-all">{maskedTarget(channel)}</span>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 pointer-coarse:min-h-11" disabled={test.isPending} onClick={() => test.mutate({ id: channel.id })}>
          {test.isPending ? 'Sending…' : 'Send test'}
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={editing} className="shrink-0 px-2.5 pointer-coarse:min-h-11" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Edit'}
        </Button>
      </div>
      {outcome ? (
        <p role="status" className={cn('pl-11 font-mono text-[11.5px]', outcome.ok ? 'text-tone-ok' : 'text-tone-bad')}>
          {outcome.ok ? `Sent ${outcome.at} · ${outcome.detail}` : `Didn’t arrive (${outcome.at}): ${outcome.detail}`}
        </p>
      ) : null}
      <Tech className="pl-11">
        {channel.id} · named by {usedBy} rule{usedBy === 1 ? '' : 's'} · also gets every “Every channel” rule
      </Tech>
      {editing ? <ChannelEdit channel={channel} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}
