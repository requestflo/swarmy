import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationChannelView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { ChannelEdit } from './channel-edit';
import { ChannelPreview } from './channel-preview';
import { ChannelKindIcon, maskedTarget } from './channel-kind-icon';
import { ChannelReceipt, type FreshTest } from './channel-receipt';
import { reachWords, type ChannelReach } from './channel-reach';

/**
 * One channel: kind icon, name, a masked target, how many rules reach it,
 * Send test, and Edit. Under it, the saved receipt of its last test (from the
 * audit log), so a failed test is still explained after a reload.
 */
export function ChannelRow({ channel, reach }: { channel: NotificationChannelView; reach: ChannelReach }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [fresh, setFresh] = React.useState<FreshTest | null>(null);
  /** When the last test went out — the preview's timestamp. */
  const [sentAt, setSentAt] = React.useState<string | null>(null);
  const test = useMutation(
    trpc.alerts.testChannel.mutationOptions({
      onMutate: () => setSentAt(new Date().toISOString()),
      onSuccess: (r) => {
        setFresh({ at: new Date().toISOString(), ok: r.ok, detail: r.detail });
        void qc.invalidateQueries({ queryKey: trpc.alerts.channels.queryKey() });
      },
      onError: (e) => setFresh({ at: new Date().toISOString(), ok: false, detail: e.message }),
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
          <span className="text-muted-foreground text-[12px]">{reachWords(reach, channel.enabled)}</span>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 pointer-coarse:min-h-11" disabled={test.isPending} onClick={() => test.mutate({ id: channel.id })}>
          {test.isPending ? 'Sending…' : 'Send test'}
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={editing} className="shrink-0 px-2.5 pointer-coarse:min-h-11" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Edit'}
        </Button>
      </div>
      <ChannelReceipt saved={channel.lastTest} fresh={fresh} />
      {sentAt && fresh?.ok ? <ChannelPreview channel={channel} at={sentAt} /> : null}
      <Tech className="pl-11">
        {`${channel.id} · named by ${reach.named} rule${reach.named === 1 ? '' : 's'} · ${reach.gets - reach.named} more go to every channel`}
      </Tech>
      {editing ? <ChannelEdit channel={channel} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}
